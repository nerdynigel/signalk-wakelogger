import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { configSchema } from './config/schema'
import { DEFAULTS, parseConfig, type PluginConfig } from './config/defaults'
import { createOutbox } from './outbox/factory'
import type { OutboxStore } from './outbox/interface'
import { CredentialStore, fingerprintPairingCode, shouldExchangePairingCode, type DeviceCredentials } from './pairing/credentials'
import { pairDevice } from './pairing/pairing-client'
import { TelemetryNormaliser } from './signalk/normaliser'
import { subscribeToTelemetry } from './signalk/subscriber'
import { legacyProfile, parseTelemetryProfile, type TelemetryProfile } from './telemetry/profile'
import { TelemetryProfileStore } from './telemetry/profile-store'
import { PathSampler } from './telemetry/sampler'
import { WakeLoggerTransport, type ConnectionState } from './transport/mqtt-client'
import { TripStateMachine, type TripSnapshot } from './trips/state-machine'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  const pluginVersion = '0.2.0-beta.0'
  let generation = 0
  let stopSubscription: (() => void) | undefined
  let sampleTimer: NodeJS.Timeout | undefined
  let statusTimer: NodeJS.Timeout | undefined
  let outbox: OutboxStore | undefined
  let transport: WakeLoggerTransport | undefined
  let tripState: TripStateMachine | undefined
  let connectionState: ConnectionState | 'unpaired' = 'unpaired'
  let activeProfile: TelemetryProfile | undefined
  let storageBackend: 'file' | 'database' = 'file'
  let initialization: Promise<void> | undefined

  const plugin: Plugin = {
    id: 'signalk-wakelogger',
    name: 'Wake Logger',
    description: 'Secure, resilient live vessel telemetry for Wake Logger',
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
      await running?.catch(() => undefined)
      await cleanupResources()
      initialization = undefined
      app.setPluginStatus('Wake Logger: Stopped')
    }
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
  }

  async function initialise(config: PluginConfig, thisGeneration: number): Promise<void> {
    const dataDirectory = app.getDataDirPath()
    const credentialStore = new CredentialStore(path.join(dataDirectory, 'identity'))
    let credentials = await credentialStore.load()
    if (shouldExchangePairingCode(credentials, config.pairingCode)) {
      app.setPluginStatus('Wake Logger: Pairing')
      try {
        const replacement = await pairDevice(config.pairingApiUrl, config.pairingCode, await credentialStore.installationId())
        if (generation !== thisGeneration) return
        replacement.pairingCodeFingerprint = fingerprintPairingCode(config.pairingCode)
        await credentialStore.save(replacement)
        credentials = replacement
      } catch (error) {
        if (!credentials) throw error
        app.error(`Wake Logger replacement pairing failed; continuing with the existing device: ${safeError(error)}`)
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
        connectionState = state
        void updateStatus(detail)
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
    app.setPluginStatus(`Wake Logger: ${connectionState} — ${queue}${dropped}${sequence}${trip}${extra}`)
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
