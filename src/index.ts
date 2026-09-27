import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { CourseStore } from './courses/course-store'
import { CourseError, parseCourse, type CourseAcknowledgement } from './courses/protocol'
import { NativeCourseService, nativeRouteHref, type NativeCourseApp } from './courses/native-course'
import { RaceProgressionService } from './race/progression-service'
import { RaceProgressionStore } from './race/progression-store'
import { ObservationCollector } from './race/observations'
import { RacePackStore } from './race/race-pack-store'
import { RacePackReceiver } from './race/race-pack-protocol'
import { OnboardSnapshotStore, type OnboardPlanSnapshot } from './race/onboard-store'
import { OnboardRaceService, type OnboardCourseState } from './race/onboard-service'
import { NavigationControlLease } from './race/navigation-control'
import { offlineReadiness, type OfflineReadiness, type ReadinessPackState } from './race/readiness'
import { UploadHistory, durableJson } from './tracking/history'
import { TrackArchive } from './tracking/archive'
import { DEFAULT_TRACK_POINTS, MAX_TRACK_POINTS } from './tracking/track'
import { configSchema } from './config/schema'
import { DEFAULTS, parseConfig, type PluginConfig } from './config/defaults'
import { createOutbox } from './outbox/factory'
import type { OutboxStats, OutboxStore } from './outbox/interface'
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

const DIAGNOSTIC_DEDUPE_MS = 60_000
const SENSITIVE_DIAGNOSTIC_KEY = 'token|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|api[_-]?key|apikey|authorization|auth|signature|session[_-]?id|code|pin'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  const pluginVersion = (JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version
  let generation = 0
  let stopSubscription: (() => void) | undefined
  let sampleTimer: NodeJS.Timeout | undefined
  let statusTimer: NodeJS.Timeout | undefined
  let outbox: OutboxStore | undefined
  let cachedQueueStats: OutboxStats | undefined
  let queueStatsAt: number | undefined
  let transport: WakeLoggerTransport | undefined
  let courses: CourseStore | undefined
  let progression: RaceProgressionService | undefined
  let racePacks: RacePackStore | undefined
  let racePackReceiver: RacePackReceiver | undefined
  let observations: ObservationCollector | undefined
  let onboardSnapshots: OnboardSnapshotStore | undefined
  let onboard: OnboardRaceService | undefined
  let onboardCourse: OnboardCourseState | null = null
  let courseInitializationError: string | undefined
  let courseFailureAcknowledgement: CourseAcknowledgement | undefined
  let tripState: RecordingStore | undefined
  let trackArchive: TrackArchive | undefined
  // Explicit, leased, generation-stamped navigation-control ownership. Only the
  // owning onboard client may apply a detected rounding; other pages are viewers.
  const navigationLease = new NavigationControlLease()
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
      const stopping = transport?.stop({ publishOffline: false, force: true })
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
      type RouteHandler = (
        request: unknown,
        response: { status: (code: number) => { json: (body: unknown) => void } },
        next: (error: unknown) => void
      ) => void | Promise<void>
      type RouteRegistrar = {
        get?: (route: string, handler: RouteHandler) => void
        post: (route: string, handler: RouteHandler) => void
      }
      const pluginRouter = router as unknown as RouteRegistrar & {
        access?: (level: 'readonly' | 'readwrite') => RouteRegistrar
      }
      // The onboard app serves ordinary crew accounts: status reads accept any
      // signed-in user and control actions require readwrite (or admin).
      // Unpairing stays administrator-only because routes registered directly
      // on the plugin router keep Signal K's administrator default. Older
      // Signal K servers without access() fall back to that default for all
      // routes.
      const readRouter = pluginRouter.access?.('readonly') ?? pluginRouter
      const writeRouter = pluginRouter.access?.('readwrite') ?? pluginRouter
      readRouter.get?.('/tracking', async (_request, response, next) => {
        try { response.status(200).json(await trackingStatus()) }
        catch (error) { next(error) }
      })
      writeRouter.post('/tracking', async (request, response, next) => {
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
            await onboard?.setAuthority(mode)
            if (mode === 'automatic' && !wasAutomatic) {
              if (outbox) await updateHistory(await outbox.stats(), true)
              await transport?.stop({ publishOffline: false, force: true })
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
      readRouter.get?.('/course', async (_request, response, next) => {
        try {
          response.status(200).json({
            ...(await courses?.status() ?? { desired: null, cachedCourse: null, acknowledgement: null, routePoints: [], native: { available: false, course: null, ownedRouteId: null, activeMatchesDesired: false, conflict: false } }),
            uploadMode: activeUploadMode, connectionState, courseError: courseInitializationError ?? transport?.transportMetrics().courseSyncError,
            offlineReadiness: await currentOfflineReadiness()
          })
        } catch (error) { next(error) }
      })
      readRouter.get?.('/offline-readiness', async (_request, response, next) => {
        try { response.status(200).json(await currentOfflineReadiness()) }
        catch (error) { next(error) }
      })
      readRouter.get?.('/track', async (request, response, next) => {
        try { response.status(200).json(await currentTrack(request)) }
        catch (error) { next(error) }
      })
      // Bounded diagnostic capture for the onboard app. Read-only: it records
      // why a local Signal K request failed and never changes any state. The
      // client sends no credentials and every field is length-bounded.
      readRouter.post?.('/diagnostics', async (request, response, next) => {
        try { logWebappDiagnostic(request); response.status(200).json({ logged: true }) }
        catch (error) { next(error) }
      })
      writeRouter.post('/course/activate', async (_request, response, next) => {
        try {
          if (!courses) throw new CourseError('no_selected_course')
          await courses.activate()
          await syncProgressionCourse()
          void transport?.publishCourseAcknowledgement().catch((error) => app.error(`Course acknowledgement deferred: ${safeError(error)}`))
          response.status(200).json({ ...await courses.status(), uploadMode: activeUploadMode, connectionState })
        } catch (error) {
          if (error instanceof CourseError) response.status(409).json({ error: error.code })
          else next(error)
        }
      })
      writeRouter.post('/course/map-readiness', async (request, response, next) => {
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
      readRouter.get?.('/progression', async (_request, response, next) => {
        try {
          response.status(200).json({ ...(progression?.status() ?? { mode: null, revision: 0, activeIndex: 0, pending: null, lastDetection: null }), control: controllerStatus() })
        } catch (error) { next(error) }
      })
      writeRouter.post('/progression/control', async (request, response, next) => {
        try {
          const body = (request as { body?: { clientId?: unknown; release?: unknown } }).body
          const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : ''
          if (!clientId || clientId.length > 80) {
            response.status(400).json({ error: 'invalid_client' })
            return
          }
          if (body?.release === true) {
            response.status(200).json({ control: navigationLease.release(clientId) })
            return
          }
          const result = navigationLease.claim(clientId)
          if (!result.ok) {
            response.status(409).json({ error: 'navigation_control_held', control: result.state })
            return
          }
          response.status(200).json({ control: result.state })
        } catch (error) { next(error) }
      })
      // The execution boundary for automatic/manual advancement. It validates
      // the controlling lease and its generation, the selected course identity
      // and revision, the still-current native point and the detection identity
      // before issuing a one-time permit. The permit is idempotent per
      // generation+detection so a retry after a lost response cannot advance
      // twice; reconciliation uses actual native state (see docs for the
      // Signal K 2.31 limitation: no plugin pointIndex write API exists, so the
      // onboard app performs the native pointIndex write after the permit).
      writeRouter.post('/progression/apply', async (request, response, next) => {
        try {
          const body = (request as { body?: Record<string, unknown> }).body
          const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : ''
          const generation = Number(body?.generation)
          const courseId = typeof body?.courseId === 'string' ? body.courseId : ''
          const revision = Number(body?.revision)
          const expectedPointIndex = Number(body?.expectedPointIndex)
          const detectionPointIndex = Number(body?.detectionPointIndex)
          const detectionRevision = Number(body?.detectionRevision)
          if (!clientId || !courseId || !Number.isSafeInteger(generation) || !Number.isSafeInteger(revision)
            || !Number.isSafeInteger(expectedPointIndex) || !Number.isSafeInteger(detectionPointIndex) || !Number.isSafeInteger(detectionRevision)) {
            response.status(400).json({ error: 'invalid_application' })
            return
          }
          const verdict = navigationLease.check(clientId, generation)
          if (verdict !== 'ok') {
            response.status(409).json({ error: verdict === 'expired' ? 'navigation_control_expired' : 'navigation_control_not_held', control: controllerStatus() })
            return
          }
          const status = courses ? await courses.status() as {
            desired?: { action?: string; revision?: number; courseId?: string } | null
            acknowledgement?: { status?: string; revision?: number } | null
            routePoints?: unknown[]
            native?: { available?: boolean; activeMatchesDesired?: boolean; course?: { activeRoute?: { href?: string; pointIndex?: number; reverse?: boolean } | null } | null } | null
          } : null
          const desired = status?.desired
          const acknowledgement = status?.acknowledgement
          if (!desired || desired.action !== 'activate' || desired.revision !== revision || desired.courseId !== courseId
            || acknowledgement?.status !== 'applied' || acknowledgement.revision !== revision) {
            response.status(409).json({ error: 'stale_course' })
            return
          }
          if (detectionRevision !== revision) {
            response.status(409).json({ error: 'stale_detection' })
            return
          }
          const native = status?.native
          const activeRoute = native?.course?.activeRoute
          if (native?.available !== true || native?.activeMatchesDesired !== true || activeRoute?.href !== nativeRouteHref(courseId)) {
            response.status(409).json({ error: 'native_route_not_active' })
            return
          }
          if (activeRoute.reverse === true) {
            response.status(409).json({ error: 'reverse_course_unsupported' })
            return
          }
          const points = status?.routePoints ?? []
          const target = detectionPointIndex + 1
          const applicationId = `${generation}:${courseId}:${revision}:${detectionPointIndex}`
          // Idempotent retry: a lost response, or the native point already
          // advanced, must not advance a second time.
          if (activeRoute.pointIndex === target || navigationLease.isApplied(applicationId)) {
            response.status(200).json({ status: 'already_applied', targetPointIndex: target, generation })
            return
          }
          if (detectionPointIndex !== expectedPointIndex || activeRoute.pointIndex !== expectedPointIndex) {
            response.status(409).json({ error: 'stale_point', expectedPointIndex, nativePointIndex: activeRoute.pointIndex ?? null })
            return
          }
          if (target >= points.length) {
            response.status(409).json({ error: 'no_next_point' })
            return
          }
          navigationLease.markApplied(applicationId)
          response.status(200).json({ status: 'apply', targetPointIndex: target, generation })
        } catch (error) { next(error) }
      })
      writeRouter.post('/progression/mode', async (request, response, next) => {
        const mode = (request as { body?: { mode?: unknown } }).body?.mode
        if (mode !== 'auto' && mode !== 'suggest' && mode !== 'off') {
          response.status(400).json({ error: 'invalid_progression_mode' })
          return
        }
        if (!progression) {
          response.status(409).json({ error: 'progression_unavailable' })
          return
        }
        try {
          await progression.setMode(mode)
          response.status(200).json(progression.status())
        } catch (error) { next(error) }
      })
      writeRouter.post('/progression/resolve', async (request, response, next) => {
        const body = (request as { body?: { resolution?: unknown; pointIndex?: unknown } }).body
        if ((body?.resolution !== 'accepted' && body?.resolution !== 'dismissed') || !Number.isSafeInteger(body?.pointIndex)) {
          response.status(400).json({ error: 'invalid_resolution' })
          return
        }
        if (!progression) {
          response.status(409).json({ error: 'progression_unavailable' })
          return
        }
        try {
          const resolved = await progression.resolve(body.resolution, body.pointIndex as number)
          if (resolved) response.status(200).json(progression.status())
          else response.status(409).json({ error: 'no_pending_detection', ...progression.status() })
        } catch (error) { next(error) }
      })
      readRouter.get?.('/race-plan', async (_request, response, next) => {
        try {
          const status = onboard?.status() as { calculationAuthority?: string; lastLocalCalculationAt?: number | null } | undefined
          response.status(200).json({
            ...(status ?? { calculationAuthority: activeUploadMode === 'local_only' ? 'onboard' : 'cloud', lastLocalCalculationAt: null, reason: 'onboard_unavailable' }),
            uploadMode: activeUploadMode,
            connectionState,
            latestSnapshot: onboardSnapshots?.latest() ?? null
          })
        } catch (error) { next(error) }
      })
      writeRouter.post('/race-plan/recalculate', async (_request, response, next) => {
        try {
          if (!onboard) {
            response.status(409).json({ error: 'onboard_unavailable' })
            return
          }
          // Explicit recalculation respects the product authority rule: while
          // Live tracking is automatic the cloud is authoritative and an
          // onboard recalculation must not run, even if MQTT is offline.
          if (activeUploadMode !== 'local_only') {
            response.status(409).json({ error: 'cloud_authority', uploadMode: activeUploadMode, ...onboard.status() })
            return
          }
          const snapshot = await onboard.refresh(true)
          response.status(200).json({ calculated: !!snapshot, snapshot, status: onboard.status() })
        } catch (error) { next(error) }
      })
      // Registered directly: unpairing keeps Signal K's admin-only default.
      pluginRouter.post('/forget-credentials', async (_request, response, next) => {
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
        '/offline-readiness': { get: { summary: 'Coupled offline readiness (course, native route, Race Pack, forecast and rule set)', responses: { '200': { description: 'Offline readiness contract' } } } },
        '/track': { get: { summary: 'Reconstruct the current recording track from durable onboard data, decimated for display', responses: { '200': { description: 'Track points and recording identity' } } } },
        '/diagnostics': { post: { summary: 'Record a bounded onboard webapp Signal K request failure in the plugin log', responses: { '200': { description: 'Diagnostic recorded' } } } },
        '/course/activate': { post: { summary: 'Explicitly activate the selected cached course', responses: { '200': { description: 'Course active' }, '409': { description: 'No selected course or native course unavailable' } } } },
        '/progression': { get: { summary: 'Read mark detection mode, active point and any pending detection', responses: { '200': { description: 'Progression status' } } } },
        '/progression/mode': { post: { summary: 'Change mark detection between automatic, suggest and off', responses: { '200': { description: 'Mode saved' }, '400': { description: 'Invalid mode' }, '409': { description: 'Progression unavailable' } } } },
        '/progression/control': { post: { summary: 'Claim, renew or release leased onboard navigation control so only one client auto-advances', responses: { '200': { description: 'Control status' }, '400': { description: 'Invalid client' }, '409': { description: 'Control held by another client' } } } },
        '/progression/apply': { post: { summary: 'Validate the controlling lease, course revision, native point and detection before a one-time, idempotent advancement permit', responses: { '200': { description: 'Permit issued or already applied' }, '400': { description: 'Invalid application' }, '409': { description: 'Stale/expired control, course or point' } } } },
        '/progression/resolve': { post: { summary: 'Resolve a pending detection as accepted or dismissed for its point index', responses: { '200': { description: 'Resolution recorded' }, '400': { description: 'Invalid resolution' }, '409': { description: 'No matching pending detection' } } } },
        '/race-plan': { get: { summary: 'Read onboard Race Plan calculation authority, Race Pack state and the latest onboard snapshot', responses: { '200': { description: 'Onboard race plan state' } } } },
        '/race-plan/recalculate': { post: { summary: 'Request an explicit onboard Race Plan recalculation (local-only authority only)', responses: { '200': { description: 'Recalculation attempted' }, '409': { description: 'Onboard planner unavailable or cloud is authoritative' } } } },
        '/forget-credentials': {
          post: {
            summary: 'Forget Wake Logger credentials while preserving all device outboxes',
            responses: { '200': { description: 'Credentials forgotten or already absent' } }
          }
        }
      }
    })
  }

  async function syncProgressionCourse(): Promise<void> {
    if (!courses) {
      progression?.updateCourse(null)
      onboardCourse = null
      return
    }
    try {
      const status = await courses.status() as {
        cachedCourse?: { revision?: number; courseId?: string; racePlanId?: number; courseDefinitionDigest?: string | null } | null
        routePoints?: Array<{ latitude: number; longitude: number; name?: string; kind?: 'start' | 'mark' | 'gate' | 'finish'; rounding?: 'port' | 'starboard' | 'either' }>
        native?: { course?: { activeRoute?: { pointIndex?: number; reverse?: boolean } | null } | null; activeMatchesDesired?: boolean }
      }
      progression?.updateCourse({
        revision: status.cachedCourse?.revision ?? 0,
        points: status.routePoints ?? [],
        reverse: status.native?.course?.activeRoute?.reverse === true,
        activeIndex: status.native?.course?.activeRoute?.pointIndex ?? 0,
        matches: status.native?.activeMatchesDesired === true
      })
      const points = status.routePoints ?? []
      onboardCourse = status.native?.activeMatchesDesired === true && status.cachedCourse?.courseId && points.length >= 2
        ? {
            courseId: status.cachedCourse.courseId,
            racePlanId: status.cachedCourse.racePlanId ?? null,
            courseDefinitionDigest: status.cachedCourse.courseDefinitionDigest ?? null,
            activeIndex: status.native?.course?.activeRoute?.pointIndex ?? 0,
            totalPoints: points.length,
            reverse: status.native?.course?.activeRoute?.reverse === true
          }
        : null
    } catch {
      progression?.updateCourse(null)
      onboardCourse = null
    }
  }

  function racingUnderway(): boolean {
    if (onboardCourse && onboardCourse.activeIndex > 0 && onboardCourse.activeIndex < onboardCourse.totalPoints) return true
    return tripState?.currentState().state === 'MOVING'
  }

  // One deterministic offline readiness contract, derived every time from the
  // selected course, the expected native route and the applied Race Pack. It is
  // never a stored toggle, so a course change immediately invalidates an older
  // pack even though that immutable pack is retained for history/recovery.
  async function currentOfflineReadiness(): Promise<OfflineReadiness> {
    const courseStatus = courses ? await courses.status() as {
      desired?: { action?: string; revision?: number; courseId?: string; racePlanId?: number; courseDefinitionDigest?: string | null } | null
      acknowledgement?: { status?: string; revision?: number } | null
      native?: { available?: boolean; activeMatchesDesired?: boolean; conflict?: boolean; course?: { activeRoute?: { reverse?: boolean } | null } | null } | null
    } : null
    const onboardStatus = onboard?.status() as { pack?: {
      available?: boolean; applicable?: boolean; revision?: number | null; ruleSetVersion?: string | null
      courseId?: string | null; racePlanId?: number | null; courseDefinitionDigest?: string | null
      validFrom?: string | null; validUntil?: string | null; coverage?: { from: string | null; until: string | null } | null; currentAt?: string
    } } | undefined
    const meta = onboardStatus?.pack
    const pack: ReadinessPackState | null = meta ? {
      available: meta.available === true,
      revision: meta.revision ?? null,
      ruleSetVersion: meta.ruleSetVersion ?? null,
      courseId: meta.courseId ?? null,
      racePlanId: meta.racePlanId ?? null,
      courseDefinitionDigest: meta.courseDefinitionDigest ?? null,
      validFrom: meta.validFrom ?? null,
      validUntil: meta.validUntil ?? null,
      coverage: meta.coverage ?? null,
      currentAt: meta.currentAt ?? 'unknown'
    } : null
    return offlineReadiness({
      course: courseStatus?.desired ?? null,
      acknowledgement: courseStatus?.acknowledgement ?? null,
      native: {
        available: courseStatus?.native?.available === true,
        activeMatchesDesired: courseStatus?.native?.activeMatchesDesired === true,
        conflict: courseStatus?.native?.conflict === true,
        reverse: courseStatus?.native?.course?.activeRoute?.reverse === true
      },
      pack,
      now: Date.now()
    })
  }

  // Reconstruct the current recording's track from the durable onboard archive
  // so the onboard map does not use page-open time or an in-memory pointer as
  // the beginning of the trip. Never reads the delivery outbox, so an upload
  // acknowledgement or segment reclaim cannot remove local map history.
  let archivedRecordingId: string | null = null
  async function currentTrack(request: unknown): Promise<object> {
    const maxPointsValue = Number((request as { query?: { maxPoints?: string } }).query?.maxPoints)
    const maxPoints = Number.isFinite(maxPointsValue)
      ? Math.max(50, Math.min(MAX_TRACK_POINTS, Math.floor(maxPointsValue)))
      : DEFAULT_TRACK_POINTS
    if (!trackArchive) {
      return { storageBackend: 'archive', points: [], summary: { fromSequence: null, throughSequence: null, totalSamples: 0, decimated: false }, recording: null, trackingSessionId: null }
    }
    const manifests = tripState?.manifests() ?? []
    const active = manifests.find((manifest) => manifest.state === 'recording')
    // The pending-upload manifests are removed after the terminal recording ACK,
    // so discovery must not depend on them: prefer the active recording, else
    // the archive's independently persisted current/most-recent recording.
    const selectedId = active?.id ?? trackArchive.currentRecordingId()
    if (!selectedId) {
      return { storageBackend: 'archive', points: [], summary: { fromSequence: null, throughSequence: null, totalSamples: 0, decimated: false }, recording: null, trackingSessionId: null }
    }
    // Prune settled older recordings when the selected recording changes, never
    // on the sample path and never the active file.
    if (selectedId !== archivedRecordingId) {
      archivedRecordingId = selectedId
      void trackArchive.prune(active?.id ?? null).catch(() => undefined)
    }
    const meta = trackArchive.recordingMeta(selectedId)
    const result = await trackArchive.read(selectedId, { maxPoints })
    const recording = active ?? (meta
      ? { id: meta.id, state: meta.closed ? 'complete' : 'closed', startedAt: meta.startedAt, endedAt: meta.endedAt, firstSequence: meta.firstSequence, lastSequence: meta.lastSequence }
      : { id: selectedId, state: 'closed', startedAt: null, endedAt: null, firstSequence: null, lastSequence: null })
    return { ...result, recording, trackingSessionId: selectedId }
  }

  function controllerStatus(): import('./race/navigation-control').NavigationControlState {
    return navigationLease.status()
  }

  // Structured, allow-listed diagnostic sanitisation. The onboard client
  // sanitises before sending, but the server must defend independently: raw
  // responses, quoted JSON credentials and URL query values are never logged.
  const diagnosticSeen = new Map<string, number>()
  function redactDiagnosticText(value: string): string {
    let out = String(value)
    const key = SENSITIVE_DIAGNOSTIC_KEY
    // Quoted JSON/JS values under sensitive keys.
    out = out.replace(new RegExp(`("(?:${key})"\\s*:\\s*)"[^"]*"`, 'gi'), '$1"[redacted]"')
    out = out.replace(new RegExp(`('(?:${key})'\\s*:\\s*)'[^']*'`, 'gi'), "$1'[redacted]'")
    // Bearer tokens before unquoted key/value matching.
    out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    // Unquoted key=value / key: value, including URL query parameters.
    out = out.replace(new RegExp(`((?:${key})\\s*[=:]\\s*)(?!\\[redacted\\])[^\\s"'&,}<>]+`, 'gi'), '$1[redacted]')
    return out.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  }
  function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
    if (depth > 4) return '[truncated]'
    if (typeof value === 'string') return redactDiagnosticText(value).slice(0, 1000)
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDiagnosticValue(item, depth + 1))
    if (typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
        result[key] = new RegExp(`^(?:${SENSITIVE_DIAGNOSTIC_KEY})$`, 'i').test(key) ? '[redacted]' : sanitizeDiagnosticValue(item, depth + 1)
      }
      return result
    }
    return undefined
  }
  function sanitizeDetail(raw: string): string {
    const trimmed = raw.slice(0, 4000)
    if (trimmed.length && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
      try { return redactDiagnosticText(JSON.stringify(sanitizeDiagnosticValue(JSON.parse(trimmed)))).slice(0, 500) }
      catch { /* Fall through to text sanitisation. */ }
    }
    return redactDiagnosticText(trimmed).slice(0, 500)
  }
  function logWebappDiagnostic(request: unknown): void {
    const body = (request as { body?: Record<string, unknown> }).body
    const text = (value: unknown, maximum: number): string => typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').slice(0, maximum) : ''
    const operation = redactDiagnosticText(text(body?.operation, 80)) || 'unknown'
    const method = text(body?.method, 10).toUpperCase() || 'GET'
    // Never log URL query values.
    const path = redactDiagnosticText(text(body?.path, 300).split('?')[0] ?? '').slice(0, 200)
    const status = typeof body?.status === 'number' && Number.isSafeInteger(body.status) ? String(body.status) : 'unknown'
    const errorCode = redactDiagnosticText(text(body?.errorCode, 80))
    const detail = sanitizeDetail(typeof body?.detail === 'string' ? body.detail : '')
    const signature = `${operation}|${method}|${path}|${status}|${errorCode}|${detail.slice(0, 120)}`
    const now = Date.now()
    const previous = diagnosticSeen.get(signature)
    if (previous !== undefined && now - previous < DIAGNOSTIC_DEDUPE_MS) return
    if (diagnosticSeen.size > 500) diagnosticSeen.clear()
    diagnosticSeen.set(signature, now)
    const message = `Wake Logger onboard webapp ${operation} ${method} ${path} -> ${status}${errorCode ? ` (${errorCode})` : ''}${detail ? `: ${detail}` : ''}`
    app.error(redactDiagnosticText(message).slice(0, 900))
  }

  async function flushProgressionEvidence(): Promise<void> {
    if (!progression || !transport) return
    const pending = progression.pendingEvents()
    if (!pending.length) return
    const published: number[] = []
    for (const event of pending) {
      try { if (!await transport.publishEvidence(event)) break }
      catch { break }
      published.push(event.sequence)
    }
    if (published.length) await progression.markPublished(published)
  }

  // Onboard snapshots are historical evidence: they only leave the vessel once
  // Live tracking is restored. A snapshot stays durable until Wake Logger
  // application-ACKs it; published-but-unacknowledged snapshots are retried.
  async function flushOnboardSnapshots(): Promise<void> {
    if (!onboardSnapshots || !transport || activeUploadMode !== 'automatic') return
    const queue = [...onboardSnapshots.pending(), ...onboardSnapshots.unacknowledged()].slice(0, 5)
    if (!queue.length) return
    const published: number[] = []
    for (const event of queue) {
      try { if (!await transport.publishRacePlanSnapshot(event.snapshot)) break }
      catch { break }
      published.push(event.sequence)
    }
    if (published.length) await onboardSnapshots.markPublished(published)
  }

  function publishOnboardSnapshot(_snapshot: OnboardPlanSnapshot): void {
    if (activeUploadMode === 'automatic') void flushOnboardSnapshots()
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
    await progression?.close()
    progression = undefined
    onboard?.close()
    onboard = undefined
    await onboardSnapshots?.close()
    onboardSnapshots = undefined
    await racePacks?.close()
    racePacks = undefined
    await trackArchive?.close().catch(() => undefined)
    trackArchive = undefined
    archivedRecordingId = null
    racePackReceiver = undefined
    observations = undefined
    onboardCourse = null
    await courses?.close()
    courses = undefined
    courseInitializationError = undefined
    courseFailureAcknowledgement = undefined
    transport = undefined
    await outbox?.close()
    outbox = undefined
    cachedQueueStats = undefined
    queueStatsAt = undefined
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
    const progressionStore = new RaceProgressionStore(path.join(dataDirectory, 'race-progression', credentials.deviceId, 'state.json'))
    try {
      await progressionStore.open()
      progression = new RaceProgressionService({ store: progressionStore, defaultMode: config.raceProgressionMode })
    } catch (error) {
      progression = undefined
      app.error(`Wake Logger mark detection unavailable: ${safeError(error)}`)
    }
    await syncProgressionCourse()
    observations = new ObservationCollector()
    const packs = new RacePackStore(path.join(dataDirectory, 'race-packs', credentials.deviceId))
    try { await packs.open() } catch (error) { app.error(`Wake Logger race pack store unavailable: ${safeError(error)}`) }
    racePacks = packs
    racePackReceiver = new RacePackReceiver({ store: packs })
    const snapshotStore = new OnboardSnapshotStore(path.join(dataDirectory, 'onboard-plans', credentials.deviceId, 'state.json'))
    try { await snapshotStore.open() } catch (error) { app.error(`Wake Logger onboard plan history unavailable: ${safeError(error)}`) }
    onboardSnapshots = snapshotStore
    onboard = new OnboardRaceService({
      packs,
      snapshots: snapshotStore,
      observations,
      course: () => onboardCourse,
      racing: racingUnderway,
      trackingSessionId: () => tripState?.currentState().trackingSessionId ?? null,
      onCalculated: publishOnboardSnapshot
    })
    const normaliser = new TelemetryNormaliser()
    const tripFile = path.join(dataDirectory, 'trip-state.json')
    const trip = new RecordingStore(path.join(dataDirectory, 'recordings', credentials.deviceId, 'state.json'))
    await trip.open(await readTripSnapshot(tripFile))
    tripState = trip
    // Durable map history, independent of whether telemetry has been uploaded
    // and acknowledged. Bounded by age/count/size and pruned off the sample path.
    trackArchive = new TrackArchive(path.join(dataDirectory, 'track-archive', credentials.deviceId))
    try { await trackArchive.open() } catch (error) {
      app.error(`Wake Logger track archive unavailable; map history may be limited: ${safeError(error)}`)
    }
    void trackArchive.prune(trip.currentState().trackingSessionId ?? null).catch(() => undefined)
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
        if (courses) {
          const acknowledgement = await courses.receive(payload)
          await syncProgressionCourse()
          return acknowledgement
        }
        let revision = 0
        try { revision = parseCourse(payload).revision } catch { /* Report unavailable storage without accepting a new course. */ }
        courseFailureAcknowledgement = { v: 1, revision, status: 'rejected', errorCode: 'course_storage_unavailable' }
        return courseFailureAcknowledgement
      },
      getCourseAcknowledgement: () => courses?.acknowledgement() ?? courseFailureAcknowledgement,
      onRacePackManifest: async (payload) => racePackReceiver?.acceptManifest(payload) ?? null,
      onRacePackChunk: async (payload, topicIndex) => racePackReceiver?.acceptChunk(payload, topicIndex) ?? null,
      getRacePackAck: () => racePackReceiver?.currentAck() ?? null,
      onRecordingAcks: async (acks) => {
        sampleOperation = sampleOperation.then(() => trip.acknowledge(acks))
        await sampleOperation
      },
      onRacePlanSnapshotAcks: async (ids) => {
        await onboardSnapshots?.acknowledge(ids)
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
    stopSubscription = subscribeToTelemetry(app, (delta) => {
      normaliser.ingest(delta)
      observations?.ingest(delta)
      if (!progression) return
      const fix = normaliser.latestFix()
      if (fix) progression.fix({ at: Date.now(), ...fix })
    })
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
        // Small append off the outbox lock; a failure here must never break
        // telemetry recording or delivery.
        if (draft.trackingSessionId && trackArchive) {
          void trackArchive.append(draft.trackingSessionId, {
            sequence: queued.sequence, capturedAt: queued.capturedAt,
            latitude: queued.values.lat, longitude: queued.values.lon
          }).catch((error) => app.error(`Wake Logger track archive append failed: ${safeError(error)}`))
        }
      } catch (error) {
        // Append may commit before a later maintenance error. Recover only on
        // failure; scanning the complete offline queue every sample is costly.
        nextSequence = (await outbox.stats()).currentSequence + 1
        throw error
      }
      // Close the archive recording when the manifest is terminal so its
      // metadata is settled even after the upload manifest is acknowledged.
      if (draft.recording && draft.recording.state !== 'recording' && trackArchive) {
        void trackArchive.markClosed(draft.recording.id, draft.recording.endedAt ?? null).catch((error) => app.error(`Wake Logger track archive close failed: ${safeError(error)}`))
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
    statusTimer = setInterval(() => { void syncProgressionCourse(); void onboard?.refresh(false); void updateStatus() }, 10_000)
    if (activeUploadMode === 'automatic') connectTransport()
    else connectionState = 'recording_locally'
    await onboard?.setAuthority(activeUploadMode)
    await updateStatus()
  }

  async function updateStatus(detail?: string, beginHistory = false): Promise<void> {
    if (connectionState === 'unpaired' || !outbox) {
      app.setPluginStatus('Wake Logger: Not paired')
      return
    }
    const stats = await outbox.stats()
    cachedQueueStats = stats
    queueStatsAt = Date.now()
    await updateHistory(stats, beginHistory)
    const queue = `${stats.messageCount} queued, ${(stats.diskBytes / 1024 / 1024).toFixed(1)} MB`
    // Lifetime loss is labelled as lifetime so it is never read as samples lost
    // from the current trip.
    const dropped = stats.droppedCount ? `, ${stats.droppedCount} dropped lifetime` : ''
    const sequence = `, seq ${stats.acknowledgedSequence}/${stats.currentSequence}`
    const trip = tripState ? `, trip ${tripState.currentState().state}` : ''
    const extra = detail ? ` — ${detail}` : ''
    const readiness = await currentOfflineReadiness().catch(() => undefined)
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
      lifetimeDroppedCount: stats.droppedCount,
      cohortDroppedSamples: history?.current()?.droppedSamples ?? null,
      offlineReadiness: readiness,
      acknowledgedSequence: stats.acknowledgedSequence,
      currentSequence: stats.currentSequence,
      trackingState: tripState?.currentState().state,
      storageBackend,
      profileId: activeProfile?.profileId,
      profileRevision: activeProfile?.revision,
      ...transport?.transportMetrics()
    })
    void flushProgressionEvidence()
    void flushOnboardSnapshots()
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
    // File outbox stats scan the durable queue; browser polls reuse the
    // normal status refresh instead of taking the outbox lock every request.
    const stats = cachedQueueStats
    const cohort = history?.current() ?? null
    return {
      uploadMode: activeUploadMode, liveTrackingEnabled: activeUploadMode === 'automatic',
      persistedUploadMode, persistenceError: persistenceError ?? null,
      paired: !!outbox, recording: !!stopSubscription && !!sampleTimer,
      trackingSessionId: tripState?.currentState().trackingSessionId ?? null,
      trackingState: tripState?.currentState().state ?? null,
      available: ready && !!outbox && connectionState !== 'device_revoked',
      connectionState, historicalUpload: cohort,
      // Loss semantics are deliberately separated. `droppedCount` inside the
      // queue is the cumulative lifetime counter and must never be presented as
      // samples lost from the current trip. `cohortDroppedSamples` is the loss
      // observed within the current historical-upload cohort, and
      // `cohortProgressKnown` is false when attribution is ambiguous.
      lifetimeDroppedCount: stats?.droppedCount ?? 0,
      cohortDroppedSamples: cohort?.droppedSamples ?? null,
      cohortProgressKnown: cohort?.progressKnown ?? null,
      queue: stats ? { messageCount: stats.messageCount, diskBytes: stats.diskBytes,
        oldestCapturedAt: stats.oldestCapturedAt ?? null, acknowledgedSequence: stats.acknowledgedSequence,
        currentSequence: stats.currentSequence, droppedCount: stats.droppedCount } : null,
      queueStatsAt: queueStatsAt ?? null, at: Date.now()
    }
  }

  function pauseTransmission(): Promise<void> | undefined {
    activeUploadMode = 'local_only'
    pairingAbortController?.abort()
    associationAbortController?.abort()
    // Send one bounded retained final status before shutting transmission down.
    // Its failure cannot prevent the fail-closed local-only transition.
    const stopping = (async () => {
      await transport?.publishFinalLocalOnlyStatus().catch(() => undefined)
      // Graceful end: a DISCONNECT suppresses the retained Last Will so it cannot
      // overwrite the retained local_only status after the plugin is gone.
      await transport?.stop({ publishOffline: false, force: false })
    })()
    currentSampler?.updateMode('NORMAL')
    connectionState = 'recording_locally'
    void onboard?.setAuthority('local_only')
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
