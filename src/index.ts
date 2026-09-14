import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { CourseStore } from './courses/course-store'
import { CourseError, parseCourse, type CourseAcknowledgement } from './courses/protocol'
import { NativeCourseService, type NativeCourseApp } from './courses/native-course'
import { UploadHistory, durableJson } from './tracking/history'
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
  const pluginVersion = (JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version
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
  let persistedUploadMode: PluginConfig['uploadMode'] = 'automatic'
  let persistenceError: string | undefined
  let rawConfiguration: Record<string, unknown> = {}
  let trackingOperation: Promise<void> = Promise.resolve()
  let trackingRevision = 0
  let ready = false
  let currentSampler: PathSampler | undefined
  let connectTransport: (() => void) | undefined
  let history: UploadHistory | undefined
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
      ready = false
      trackingRevision += 1
      rawConfiguration = structuredClone(configuration) as Record<string, unknown>
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
        if (thisGeneration === generation) {
          await initialise(parseConfig(configuration), thisGeneration)
          ready = thisGeneration === generation
        }
      })().catch((error: unknown) => {
        if (thisGeneration !== generation) return
        const message = safeError(error)
        app.setPluginError(`Wake Logger initialization failed: ${message}`)
        app.error(`Wake Logger initialization failed: ${message}`)
      })
    },
    async stop(): Promise<void> {
      ready = false
      trackingRevision += 1
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
      adminRouter.get?.('/tracking', async (_request, response, next) => {
        try { response.status(200).json(await trackingStatus()) }
        catch (error) { next(error) }
      })
      adminRouter.post('/tracking', async (request, response, next) => {
        const mode = (request as { body?: { uploadMode?: unknown } }).body?.uploadMode
        if (mode !== 'automatic' && mode !== 'local_only') {
          response.status(400).json({ error: 'invalid_upload_mode' })
          return
        }
        if (!ready || !outbox || !transport || connectionState === 'device_revoked') {
          response.status(409).json({ error: 'tracking_unavailable', ...await trackingStatus() })
          return
        }
        const revision = ++trackingRevision
        const thisGeneration = generation
        // Off wins immediately, even while an earlier options save is pending.
        const stopping = mode === 'local_only' ? pauseTransmission() : undefined
        const pauseGuard = mode === 'local_only'
          ? durableJson(path.join(app.getDataDirPath(), 'tracking-pause.json'), { paused: true, at: Date.now() }).catch((error) => { app.error(`Unable to persist immediate tracking pause: ${safeError(error)}`) })
          : undefined
        const operation = trackingOperation.then(async () => {
          await stopping
          await pauseGuard
          if (generation !== thisGeneration || !ready) throw new Error('tracking_restarted')
          if (revision !== trackingRevision) return
          const wasAutomatic = activeUploadMode === 'automatic'
          await persistTrackingMode(mode, revision, thisGeneration)
          if (revision === trackingRevision && generation === thisGeneration) {
            activeUploadMode = mode
            if (mode === 'automatic' && !wasAutomatic) {
              if (outbox) await updateHistory(await outbox.stats(), true)
              await transport?.stop(false)
              connectTransport?.()
            }
            await updateStatus()
          }
        })
        trackingOperation = operation.catch(() => undefined)
        try { await operation; response.status(200).json(await trackingStatus()) }
        catch (error) {
          if (persistenceError) response.status(503).json({ error: 'tracking_persistence_failed', ...await trackingStatus() })
          else if (error instanceof Error && error.message === 'tracking_restarted') response.status(409).json({ error: 'tracking_restarted', ...await trackingStatus() })
          else next(error)
        }
      })
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
          ready = false
          trackingRevision += 1
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
        '/tracking': { get: { summary: 'Read live upload mode and the local queue', responses: { '200': { description: 'Tracking status' } } }, post: { summary: 'Persist and apply live upload mode without restarting recording', responses: { '200': { description: 'Tracking mode saved' }, '400': { description: 'Invalid mode' }, '409': { description: 'Tracking unavailable' }, '503': { description: 'Persistence failed; see actual mode in response' } } } },
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
    await trackingOperation
    await history?.close()
    history = undefined
    currentSampler = undefined
    connectTransport = undefined
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
    persistedUploadMode = config.uploadMode
    persistenceError = undefined
    activeUploadMode = config.uploadMode
    try {
      await fs.access(path.join(app.getDataDirPath(), 'tracking-pause.json'))
      activeUploadMode = 'local_only'
      persistenceError = 'A previous save failed; uploads remain paused until this setting is saved successfully.'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        activeUploadMode = 'local_only'
        persistenceError = 'Unable to read the upload safety state; uploads remain paused.'
      }
    }
    config.uploadMode = activeUploadMode
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
    const sampler = new PathSampler(profile, activeUploadMode === 'local_only' ? 'NORMAL' : 'OFFLINE')
    currentSampler = sampler
    const selected = await createOutbox(app, dataDirectory, credentials.deviceId, {
      maxBytes: config.maxOutboxMb * 1024 * 1024,
      maxAgeMs: config.maxOutboxDays * 24 * 60 * 60 * 1000,
      segmentBytes: DEFAULTS.segmentBytes
    }, credentials.outboxBinding?.backend)
    outbox = selected.store
    storageBackend = selected.backend
    history = new UploadHistory(path.join(dataDirectory, 'uploads', credentials.deviceId, 'state.json'))
    try { await history.open() } catch (error) {
      app.error(`Wake Logger upload progress unavailable: ${safeError(error)}`)
      history = undefined
    }
    if (history) await updateHistory(await outbox.stats(), activeUploadMode === 'automatic')
    let nextSequence = (await outbox.stats()).currentSequence + 1
    if (!credentials.outboxBinding) {
      credentials.outboxBinding = { version: 1, backend: selected.backend, initializedAt: Date.now() }
      await credentialStore.save(credentials)
    }
    if (generation !== thisGeneration) return
    connectTransport = () => {
      const instance = new WakeLoggerTransport(credentials, selected.store, {
      profile: activeProfile ?? profile,
      onState: (state, detail) => {
        if (transport !== instance || activeUploadMode !== 'automatic' || connectionState === 'device_revoked') return
        connectionState = state
        void updateStatus(detail, state === 'online')
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
      onMode: (mode) => { if (transport === instance) sampler.updateMode(activeUploadMode === 'local_only' ? 'NORMAL' : mode) },
      onProfile: async (replacement) => {
        await profileStore.save(replacement)
        activeProfile = replacement
        sampler.updateProfile(replacement)
      },
      debug: config.debugTelemetry ? (message) => app.debug(message) : undefined
    })
      transport = instance
      instance.start()
    }
    // Keep an inert transport in local-only mode for local status/ACK methods.
    if (activeUploadMode === 'local_only') {
      transport = new WakeLoggerTransport(credentials, selected.store, { profile, onState: () => undefined })
    }
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
    if (activeUploadMode === 'automatic') connectTransport()
    else connectionState = 'recording_locally'
    await updateStatus()
  }

  async function updateStatus(detail?: string, beginHistory = false): Promise<void> {
    if (connectionState === 'unpaired' || !outbox) {
      app.setPluginStatus('Wake Logger: Not paired')
      return
    }
    const stats = await outbox.stats()
    await updateHistory(stats, beginHistory)
    const queue = `${stats.messageCount} queued, ${(stats.diskBytes / 1024 / 1024).toFixed(1)} MB`
    const dropped = stats.droppedCount ? `, ${stats.droppedCount} dropped` : ''
    const sequence = `, seq ${stats.acknowledgedSequence}/${stats.currentSequence}`
    const trip = tripState ? `, trip ${tripState.currentState().state}` : ''
    const extra = detail ? ` — ${detail}` : ''
    transport?.updateStatus({
      pluginVersion,
      historicalUpload: history?.current(),
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

  async function updateHistory(stats: import('./outbox/interface').OutboxStats, begin = false): Promise<void> {
    try { await history?.update(stats, begin) }
    catch (error) {
      app.error(`Wake Logger upload progress unavailable: ${safeError(error)}`)
      history = undefined
    }
  }

  async function trackingStatus(): Promise<object> {
    const stats = await outbox?.stats()
    if (stats) await updateHistory(stats)
    return {
      uploadMode: activeUploadMode, liveTrackingEnabled: activeUploadMode === 'automatic',
      persistedUploadMode, persistenceError: persistenceError ?? null,
      paired: !!outbox, recording: !!stopSubscription && !!sampleTimer,
      available: ready && !!outbox && connectionState !== 'device_revoked',
      connectionState, historicalUpload: history?.current() ?? null,
      queue: stats ? { messageCount: stats.messageCount, diskBytes: stats.diskBytes,
        oldestCapturedAt: stats.oldestCapturedAt ?? null, acknowledgedSequence: stats.acknowledgedSequence,
        currentSequence: stats.currentSequence, droppedCount: stats.droppedCount } : null,
      at: Date.now()
    }
  }

  function pauseTransmission(): Promise<void> | undefined {
    activeUploadMode = 'local_only'
    pairingAbortController?.abort()
    associationAbortController?.abort()
    const stopping = transport?.stop(false)
    currentSampler?.updateMode('NORMAL')
    connectionState = 'recording_locally'
    return stopping
  }

  async function persistTrackingMode(mode: PluginConfig['uploadMode'], revision: number, thisGeneration: number): Promise<void> {
    const guard = path.join(app.getDataDirPath(), 'tracking-pause.json')
    try {
      const options = app.readPluginOptions?.() as { configuration?: Record<string, unknown> } | undefined
      const configuration = { ...(options?.configuration ?? rawConfiguration), uploadMode: mode }
      await new Promise<void>((resolve, reject) => {
        app.savePluginOptions(configuration, (error) => error ? reject(error) : resolve())
      })
      rawConfiguration = configuration
      persistedUploadMode = mode
      if (revision === trackingRevision && generation === thisGeneration) await fs.unlink(guard).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      persistenceError = undefined
    } catch (error) {
      persistenceError = safeError(error)
      await pauseTransmission()
      try { await durableJson(guard, { paused: true, at: Date.now() }) }
      catch { persistenceError += '; unable to persist the safety pause — restart persistence is not confirmed' }
      throw error
    }
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
