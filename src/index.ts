import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CourseStore } from './courses/course-store'
import { CourseError, parseCourse, type CourseAcknowledgement } from './courses/protocol'
import { NativeCourseService, type NativeCourseApp } from './courses/native-course'
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
import { type TripSnapshot } from './trips/state-machine'
import { RecordingStore } from './trips/recording-store'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  const pluginVersion = '0.2.0-beta.2'
  let generation = 0
  let stopSubscription: (() => void) | undefined
  let sampleTimer: NodeJS.Timeout | undefined
  let statusTimer: NodeJS.Timeout | undefined
  let outbox: OutboxStore | undefined
  let transport: WakeLoggerTransport | undefined
  let courses: CourseStore | undefined
  let courseInitializationError: string | undefined
  let courseFailureAcknowledgement: CourseAcknowledgement | undefined
  let tripState: RecordingStore | undefined
  let activeUploadMode: PluginConfig['uploadMode'] = 'automatic'
  let sampleOperation: Promise<void> = Promise.resolve()
  let connectionState: ConnectionState | 'unpaired' | 'device_revoked' | 'recording_locally' = 'unpaired'
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
      pairingAbortController?.abort()
      associationAbortController?.abort()
      // Stop all transmission immediately when a saved configuration restarts us.
      const stopping = transport?.stop(false)
      const previous = initialization
      const thisGeneration = ++generation
      initialization = (async () => {
        await stopping
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
        get?: (route: string, handler: (request: unknown, response: { status: (code: number) => { json: (body: unknown) => void } }, next: (error: unknown) => void) => void) => void
        post: (route: string, handler: (
          request: unknown,
          response: { status: (code: number) => { json: (body: unknown) => void } },
          next: (error: unknown) => void
        ) => Promise<void>) => void
      }
      adminRouter.get?.('/course', async (_request, response, next) => {
        try {
          response.status(200).json({
            ...(await courses?.status() ?? { desired: null, cachedCourse: null, acknowledgement: null, routePoints: [], native: { available: false, course: null, ownedRouteId: null, activeMatchesDesired: false, conflict: false } }),
            uploadMode: activeUploadMode, connectionState, courseError: courseInitializationError
          })
        } catch (error) { next(error) }
      })
      adminRouter.post('/course/activate', async (_request, response, next) => {
        try {
          if (!courses) throw new CourseError('no_selected_course')
          await courses.activate()
          void transport?.publishCourseAcknowledgement().catch((error) => app.error(`Course acknowledgement deferred: ${safeError(error)}`))
          response.status(200).json({ ...await courses.status(), uploadMode: activeUploadMode, connectionState })
        } catch (error) {
          if (error instanceof CourseError) response.status(409).json({ error: error.code })
          else next(error)
        }
      })
      adminRouter.post('/course/map-readiness', async (request, response, next) => {
        try {
          if (!courses) throw new CourseError('no_selected_course')
          const body = (request as { body?: { revision?: unknown; status?: unknown } }).body
          await courses.setMapReadiness(body?.revision, body?.status)
          void transport?.publishCourseAcknowledgement().catch((error) => app.error(`Course acknowledgement deferred: ${safeError(error)}`))
          response.status(200).json(await courses.status())
        } catch (error) {
          if (error instanceof CourseError) response.status(409).json({ error: error.code })
          else next(error)
        }
      })
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
        '/course': { get: { summary: 'Read cached and native course state', responses: { '200': { description: 'Course state' } } } },
        '/course/map-readiness': { post: { summary: 'Report locally verified chart readiness for a course revision', responses: { '200': { description: 'Readiness saved' }, '409': { description: 'Invalid or stale revision' } } } },
        '/course/activate': { post: { summary: 'Explicitly activate the selected cached course', responses: { '200': { description: 'Course active' }, '409': { description: 'No selected course or native course unavailable' } } } },
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
    await sampleOperation
    await courses?.close()
    courses = undefined
    courseInitializationError = undefined
    courseFailureAcknowledgement = undefined
    transport = undefined
    await outbox?.close()
    outbox = undefined
    tripState = undefined
    pairingAbortController = undefined
    associationAbortController = undefined
    associationCheck = undefined
  }

  async function initialise(config: PluginConfig, thisGeneration: number): Promise<void> {
    activeUploadMode = config.uploadMode
    const dataDirectory = app.getDataDirPath()
    const credentialStore = new CredentialStore(path.join(dataDirectory, 'identity'))
    let credentials = await credentialStore.load()
    const lastPairingCodeFingerprint = await credentialStore.lastPairingCodeFingerprint()
    if (config.uploadMode === 'automatic' && shouldExchangePairingCode(credentials, config.pairingCode, lastPairingCodeFingerprint)) {
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
      app.setPluginStatus(config.uploadMode === 'local_only' ? 'Wake Logger: Not paired — switch to automatic and pair before recording locally' : 'Wake Logger: Not paired')
      return
    }
    if (generation !== thisGeneration) return
    await startTelemetry(config, credentials, credentialStore, dataDirectory, thisGeneration)
  }

  async function startTelemetry(config: PluginConfig, credentials: DeviceCredentials, credentialStore: CredentialStore, dataDirectory: string, thisGeneration: number): Promise<void> {
    courses = new CourseStore(path.join(dataDirectory, 'courses', credentials.deviceId, 'state.json'), new NativeCourseService(app as unknown as NativeCourseApp))
    try { await courses.open() }
    catch (error) {
      courses = undefined
      courseInitializationError = safeError(error)
      app.error(`Wake Logger course cache unavailable; telemetry recording continues: ${courseInitializationError}`)
    }
    const normaliser = new TelemetryNormaliser()
    const tripFile = path.join(dataDirectory, 'trip-state.json')
    const trip = new RecordingStore(path.join(dataDirectory, 'recordings', credentials.deviceId, 'state.json'))
    await trip.open(await readTripSnapshot(tripFile))
    tripState = trip
    // Each provisioned device owns an independent sequence space. A replacement
    // device must never replay the retired device's records under new credentials.
    const profileStore = new TelemetryProfileStore(path.join(dataDirectory, 'profiles', credentials.deviceId))
    const credentialProfile = parseTelemetryProfile(credentials.telemetryProfile)
    const legacy = credentials.telemetryProfile as { sample_period_ms?: number; batch_size?: number } | undefined
    const profile = await profileStore.load() ?? credentialProfile ?? legacyProfile(legacy?.sample_period_ms ?? config.samplePeriodMs, legacy?.batch_size)
    activeProfile = profile
    const sampler = new PathSampler(profile, config.uploadMode === 'local_only' ? 'NORMAL' : 'OFFLINE')
    const selected = await createOutbox(app, dataDirectory, credentials.deviceId, {
      maxBytes: config.maxOutboxMb * 1024 * 1024,
      maxAgeMs: config.maxOutboxDays * 24 * 60 * 60 * 1000,
      segmentBytes: DEFAULTS.segmentBytes
    }, credentials.outboxBinding?.backend)
    outbox = selected.store
    storageBackend = selected.backend
    let nextSequence = (await outbox.stats()).currentSequence + 1
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
      onCourse: async (payload) => {
        if (courses) return courses.receive(payload)
        let revision = 0
        try { revision = parseCourse(payload).revision } catch { /* Report unavailable storage without accepting a new course. */ }
        courseFailureAcknowledgement = { v: 1, revision, status: 'rejected', errorCode: 'course_storage_unavailable' }
        return courseFailureAcknowledgement
      },
      getCourseAcknowledgement: () => courses?.acknowledgement() ?? courseFailureAcknowledgement,
      onRecordingAcks: async (acks) => {
        sampleOperation = sampleOperation.then(() => trip.acknowledge(acks))
        await sampleOperation
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
    const sample = async () => {
      if (generation !== thisGeneration) return
      const now = Date.now()
      const draft = normaliser.takeSample(now, sampler.dueFields(now))
      if (!draft || !outbox) return
      await trip.prepare(draft, nextSequence)
      let queued
      try {
        queued = await outbox.append(credentials.deviceId, draft)
        nextSequence = queued.sequence + 1
      } catch (error) {
        // Append may commit before a later maintenance error. Recover only on
        // failure; scanning the complete offline queue every sample is costly.
        nextSequence = (await outbox.stats()).currentSequence + 1
        throw error
      }
      transport?.updateCurrent(queued)
      if (config.debugTelemetry) app.debug(`Queued Wake Logger sequence ${queued.sequence}`)
    }
    const scheduleSample = () => {
      if (generation !== thisGeneration) return
      sampleTimer = setTimeout(() => {
        sampleOperation = sampleOperation.then(sample).catch((error) => app.error(`Unable to queue Wake Logger telemetry: ${safeError(error)}`)).then(scheduleSample)
      }, sampler.samplePeriodMs())
    }
    scheduleSample()
    statusTimer = setInterval(() => void updateStatus(), 10_000)
    if (config.uploadMode === 'automatic') transport.start()
    else connectionState = 'recording_locally'
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
      uploadMode: activeUploadMode,
      recordings: tripState?.statusManifests(),
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
    void transport?.publishCourseAcknowledgement().catch((error) => app.error(`Unable to report Wake Logger course: ${safeError(error)}`))
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

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(password|token|secret)=\S+/gi, '$1=[redacted]').slice(0, 500)
}

export = constructor
