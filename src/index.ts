import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { configSchema } from './config/schema'
import { DEFAULTS, parseConfig, type PluginConfig } from './config/defaults'
import { createOutbox } from './outbox/factory'
import type { OutboxStore } from './outbox/interface'
import { checkAssociationStatus } from './pairing/association-client'
import { CredentialStore, fingerprintPairingCode, shouldExchangePairingCode, type DeviceCredentials } from './pairing/credentials'
import { PairingError, pairDeviceWithRetry } from './pairing/pairing-client'
import { TelemetryNormaliser } from './signalk/normaliser'
import { subscribeToTelemetry } from './signalk/subscriber'
import { legacyProfile, parseTelemetryProfile, type TelemetryProfile } from './telemetry/profile'
import { TelemetryProfileStore } from './telemetry/profile-store'
import { PathSampler } from './telemetry/sampler'
import { WakeLoggerTransport, type ConnectionState } from './transport/mqtt-client'
import { TripStateMachine, type TripSnapshot } from './trips/state-machine'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  const pluginVersion = '0.2.0-beta.2'
  let generation = 0
  let stopSubscription: (() => void) | undefined
  let sampleTimer: NodeJS.Timeout | undefined
  let statusTimer: NodeJS.Timeout | undefined
  let outbox: OutboxStore | undefined
  let transport: WakeLoggerTransport | undefined
  let tripState: TripStateMachine | undefined
  let connectionState: ConnectionState | 'unpaired' | 'device_revoked' = 'unpaired'
  let activeProfile: TelemetryProfile | undefined
  let storageBackend: 'file' | 'database' = 'file'
  let initialization: Promise<void> | undefined
  let pairingAbortController: AbortController | undefined
  let associationAbortController: AbortController | undefined
  let associationCheck: Promise<void> | undefined

  const plugin: Plugin = {
    id: 'signalk-wakelogger',
    name: 'Wake Logger',
    description: 'Live vessel tracking and resilient Signal K telemetry for Wake Logger',
    schema: configSchema,
    start(configuration: object): void {
      const previous = initialization
      const thisGeneration = ++generation
      initialization = (async () => {
        await previous?.catch(() => undefined)
        await cleanupResources()
        if (thisGeneration === generation) await initialise(parseConfig(configuration), thisGeneration)
      })().catch((error: unknown) => {
        if (thisGeneration !== generation) return
        const message = safeError(error)
        app.setPluginError(`Wake Logger initialization failed: ${message}`)
        app.error(`Wake Logger initialization failed: ${message}`)
      })
    },
    async stop(): Promise<void> {
      const running = initialization
      generation += 1
      pairingAbortController?.abort()
      associationAbortController?.abort()
      await running?.catch(() => undefined)
      await cleanupResources()
      initialization = undefined
      app.setPluginStatus('Wake Logger: Stopped')
    },
    registerWithRouter(router): void {
      // Signal K protects routes registered directly on the plugin router with
      // administrator authentication. Do not downgrade this action via access().
      const adminRouter = router as unknown as {
        post: (route: string, handler: (
          request: unknown,
          response: { status: (code: number) => { json: (body: unknown) => void } },
          next: (error: unknown) => void
        ) => Promise<void>) => void
      }
      adminRouter.post('/forget-credentials', async (_request, response, next) => {
        try {
          generation += 1
          pairingAbortController?.abort()
          associationAbortController?.abort()
          await initialization?.catch(() => undefined)
          await cleanupResources()
          const store = new CredentialStore(path.join(app.getDataDirPath(), 'identity'))
          const result = await store.forget()
          initialization = undefined
          connectionState = 'unpaired'
          app.setPluginStatus('Wake Logger: Not paired — credentials forgotten; retired outboxes preserved')
          response.status(200).json({
            forgotten: result.forgotten,
            retiredDeviceId: result.deviceId,
            outboxesPreserved: true,
            next: 'Enter and save a fresh Wake Logger pairing code.'
          })
        } catch (error) { next(error) }
      })
    },
    getOpenApi: () => ({
      openapi: '3.0.3',
      info: { title: 'Wake Logger Signal K plugin', version: pluginVersion },
      paths: {
        '/forget-credentials': {
          post: {
            summary: 'Forget Wake Logger credentials while preserving all device outboxes',
            responses: { '200': { description: 'Credentials forgotten or already absent' } }
          }
        }
      }
    })
  }

  async function cleanupResources(): Promise<void> {
    stopSubscription?.()
    stopSubscription = undefined
    if (sampleTimer) clearTimeout(sampleTimer)
    if (statusTimer) clearInterval(statusTimer)
    sampleTimer = undefined
    statusTimer = undefined
    await transport?.stop()
    transport = undefined
    await outbox?.close()
    outbox = undefined
    tripState = undefined
    pairingAbortController = undefined
    associationAbortController = undefined
    associationCheck = undefined
  }

  async function initialise(config: PluginConfig, thisGeneration: number): Promise<void> {
    const dataDirectory = app.getDataDirPath()
    const credentialStore = new CredentialStore(path.join(dataDirectory, 'identity'))
    let credentials = await credentialStore.load()
    const lastPairingCodeFingerprint = await credentialStore.lastPairingCodeFingerprint()
    if (shouldExchangePairingCode(credentials, config.pairingCode, lastPairingCodeFingerprint)) {
      const controller = new AbortController()
      pairingAbortController = controller
      try {
        const replacement = await pairDeviceWithRetry(config.pairingApiUrl, config.pairingCode, await credentialStore.installationId(), {
          signal: controller.signal,
          onAttempt: (attempt, maximum) => {
            if (generation === thisGeneration) app.setPluginStatus(`Wake Logger: Pairing attempt ${attempt}/${maximum}`)
          },
          onRetry: (attempt, maximum, delayMs) => {
            if (generation === thisGeneration) app.setPluginStatus(`Wake Logger: Retry pairing ${attempt}/${maximum} in ${Math.ceil(delayMs / 1000)} seconds`)
          }
        })
        if (generation !== thisGeneration) return
        replacement.pairingCodeFingerprint = fingerprintPairingCode(config.pairingCode)
        await credentialStore.save(replacement)
        credentials = replacement
      } catch (error) {
        if (generation !== thisGeneration || controller.signal.aborted) return
        if (!credentials) {
          connectionState = 'unpaired'
          const expired = error instanceof PairingError && error.status === 400
          const retryExhausted = error instanceof PairingError && error.retryable
          app.setPluginStatus(
            expired
              ? 'Wake Logger: Pairing code invalid or expired — enter a new pairing code'
              : retryExhausted
                ? 'Wake Logger: Retry pairing stopped after 6 attempts — save configuration to retry or enter a new code'
                : `Wake Logger: Pairing rejected — ${safeError(error)}; enter a new pairing code`
          )
          return
        }
        app.error(`Wake Logger replacement pairing failed; continuing with the existing device: ${safeError(error)}`)
      } finally {
        if (pairingAbortController === controller) pairingAbortController = undefined
      }
    }
    if (!credentials) {
      connectionState = 'unpaired'
      app.setPluginStatus('Wake Logger: Not paired')
      return
    }
    if (generation !== thisGeneration) return
    await startTelemetry(config, credentials, credentialStore, dataDirectory, thisGeneration)
  }

  async function startTelemetry(config: PluginConfig, credentials: DeviceCredentials, credentialStore: CredentialStore, dataDirectory: string, thisGeneration: number): Promise<void> {
    const normaliser = new TelemetryNormaliser()
    const tripFile = path.join(dataDirectory, 'trip-state.json')
    const trip = new TripStateMachine(await readTripSnapshot(tripFile))
    tripState = trip
    let tripSnapshotJson = JSON.stringify(trip.currentState())
    // Each provisioned device owns an independent sequence space. A replacement
    // device must never replay the retired device's records under new credentials.
    const profileStore = new TelemetryProfileStore(path.join(dataDirectory, 'profiles', credentials.deviceId))
    const credentialProfile = parseTelemetryProfile(credentials.telemetryProfile)
    const legacy = credentials.telemetryProfile as { sample_period_ms?: number; batch_size?: number } | undefined
    const profile = await profileStore.load() ?? credentialProfile ?? legacyProfile(legacy?.sample_period_ms ?? config.samplePeriodMs, legacy?.batch_size)
    activeProfile = profile
    const sampler = new PathSampler(profile)
    const selected = await createOutbox(app, dataDirectory, credentials.deviceId, {
      maxBytes: config.maxOutboxMb * 1024 * 1024,
      maxAgeMs: config.maxOutboxDays * 24 * 60 * 60 * 1000,
      segmentBytes: DEFAULTS.segmentBytes
    }, credentials.outboxBinding?.backend)
    outbox = selected.store
    storageBackend = selected.backend
    if (!credentials.outboxBinding) {
      credentials.outboxBinding = { version: 1, backend: selected.backend, initializedAt: Date.now() }
      await credentialStore.save(credentials)
    }
    if (generation !== thisGeneration) return
    transport = new WakeLoggerTransport(credentials, outbox, {
      profile,
      onState: (state, detail) => {
        if (connectionState === 'device_revoked') return
        connectionState = state
        void updateStatus(detail)
        if (state === 'authentication_failed') void confirmAssociation(credentials, thisGeneration)
      },
      onMode: (mode) => sampler.updateMode(mode),
      onProfile: async (replacement) => {
        await profileStore.save(replacement)
        activeProfile = replacement
        sampler.updateProfile(replacement)
      },
      debug: config.debugTelemetry ? (message) => app.debug(message) : undefined
    })
    stopSubscription = subscribeToTelemetry(app, (delta) => normaliser.ingest(delta))
    const sample = () => {
      const now = Date.now()
      const draft = normaliser.takeSample(now, sampler.dueFields(now))
      if (!draft || !outbox || !transport) return
      const evidence = trip.process(draft)
      draft.trackingSessionId = evidence?.trackingSessionId ?? trip.trackingSessionId()
      if (evidence) draft.evidence = evidence
      const nextSnapshotJson = JSON.stringify(trip.currentState())
      if (nextSnapshotJson !== tripSnapshotJson) {
        tripSnapshotJson = nextSnapshotJson
        void atomicWrite(tripFile, `${tripSnapshotJson}\n`).catch((error) => app.error(`Unable to persist Wake Logger trip state: ${safeError(error)}`))
      }
      void outbox.append(credentials.deviceId, draft).then((sample) => {
        transport?.updateCurrent(sample)
        if (config.debugTelemetry) app.debug(`Queued Wake Logger sequence ${sample.sequence}`)
      }).catch((error) => app.error(`Unable to queue Wake Logger telemetry: ${safeError(error)}`))
    }
    const scheduleSample = () => {
      if (generation !== thisGeneration) return
      sampleTimer = setTimeout(() => {
        sample()
        scheduleSample()
      }, sampler.samplePeriodMs())
    }
    scheduleSample()
    statusTimer = setInterval(() => void updateStatus(), 10_000)
    transport.start()
    await updateStatus()
  }

  async function updateStatus(detail?: string): Promise<void> {
    if (connectionState === 'unpaired' || !outbox) {
      app.setPluginStatus('Wake Logger: Not paired')
      return
    }
    const stats = await outbox.stats()
    const queue = `${stats.messageCount} queued, ${(stats.diskBytes / 1024 / 1024).toFixed(1)} MB`
    const dropped = stats.droppedCount ? `, ${stats.droppedCount} dropped` : ''
    const sequence = `, seq ${stats.acknowledgedSequence}/${stats.currentSequence}`
    const trip = tripState ? `, trip ${tripState.currentState().state}` : ''
    const extra = detail ? ` — ${detail}` : ''
    transport?.updateStatus({
      pluginVersion,
      connectionState,
      queueMessageCount: stats.messageCount,
      queueDiskBytes: stats.diskBytes,
      queueOldestCapturedAt: stats.oldestCapturedAt,
      queueDroppedCount: stats.droppedCount,
      acknowledgedSequence: stats.acknowledgedSequence,
      currentSequence: stats.currentSequence,
      trackingState: tripState?.currentState().state,
      storageBackend,
      profileId: activeProfile?.profileId,
      profileRevision: activeProfile?.revision,
      ...transport?.transportMetrics()
    })
    if (connectionState === 'device_revoked') {
      app.setPluginStatus(`Wake Logger: Device revoked — enter a new pairing code; ${queue}${dropped}${sequence}`)
      return
    }
    app.setPluginStatus(`Wake Logger: ${connectionState} — ${queue}${dropped}${sequence}${trip}${extra}`)
  }

  function confirmAssociation(credentials: DeviceCredentials, thisGeneration: number): Promise<void> {
    if (associationCheck) return associationCheck
    const controller = new AbortController()
    associationAbortController = controller
    associationCheck = (async () => {
      const status = await checkAssociationStatus(credentials, controller.signal)
      if (status !== 'revoked' || generation !== thisGeneration || controller.signal.aborted) return
      connectionState = 'device_revoked'
      stopSubscription?.()
      stopSubscription = undefined
      if (sampleTimer) clearTimeout(sampleTimer)
      sampleTimer = undefined
      await transport?.stop()
      await updateStatus()
    })().finally(() => {
      if (associationAbortController === controller) associationAbortController = undefined
      associationCheck = undefined
    })
    return associationCheck
  }

  return plugin
}

async function readTripSnapshot(target: string): Promise<TripSnapshot | undefined> {
  try { return JSON.parse(await fs.readFile(target, 'utf8')) as TripSnapshot }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, contents, { mode: 0o600 })
  await fs.rename(temporary, target)
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(password|token|secret)=\S+/gi, '$1=[redacted]').slice(0, 500)
}

export = constructor
