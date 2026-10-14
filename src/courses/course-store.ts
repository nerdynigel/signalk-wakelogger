import { promises as fs } from 'node:fs'
import path from 'node:path'
import { NativeCourseService, nativeRouteId } from './native-course'
import { CourseError, coursePoints, parseCourse, type ActiveCourseDocument, type CourseAcknowledgement, type CourseDocument, type MapReadiness } from './protocol'

export interface LegStart { identity: string; observedAt: number; startedAt: number | null; position: { latitude: number; longitude: number } | null; positionTimestamp: number | null }
interface Snapshot { version: 1; legStart?: LegStart; mapReadiness?: { revision: number; status: MapReadiness }; desired?: CourseDocument; cachedCourse?: ActiveCourseDocument; acknowledgement?: CourseAcknowledgement }

export class CourseStore {
  private snapshot: Snapshot = { version: 1 }
  private operation: Promise<void> = Promise.resolve()
  private latestLegPosition: { position: { latitude: number; longitude: number }; at: number } | null = null
  constructor(private readonly target: string, private readonly native: NativeCourseService) {}

  async open(): Promise<void> {
    try {
      const stored = JSON.parse(await fs.readFile(this.target, 'utf8')) as Snapshot
      if (stored.version !== 1) throw new CourseError('course_checkpoint_invalid')
      if (stored.desired) stored.desired = parseCourse(Buffer.from(JSON.stringify(stored.desired)))
      if (stored.cachedCourse) {
        const course = parseCourse(Buffer.from(JSON.stringify(stored.cachedCourse)))
        if (course.action !== 'activate') throw new CourseError('course_checkpoint_invalid')
        stored.cachedCourse = course
      }
      if (stored.desired?.action === 'activate' && JSON.stringify(stored.desired) !== JSON.stringify(stored.cachedCourse)) throw new CourseError('course_checkpoint_invalid')
      if (stored.acknowledgement && (!['applied', 'rejected'].includes(stored.acknowledgement.status) || !Number.isSafeInteger(stored.acknowledgement.revision) || stored.acknowledgement.revision < 0)) throw new CourseError('course_checkpoint_invalid')
      this.snapshot = stored
      if (stored.cachedCourse && this.native.available()) {
        try {
          await this.native.ensureResource(stored.cachedCourse)
          // The installed native clearDestination wrapper does not persist its
          // clear. Reconcile desired clear even offline after server restart.
          if (stored.desired?.action === 'clear') await this.native.clearOwned(stored.cachedCourse)
        }
        catch (error) {
          const courseError = error instanceof CourseError ? error : undefined
          this.snapshot.acknowledgement = {
            v: 1, revision: stored.desired?.revision ?? stored.cachedCourse.revision, status: 'rejected',
            errorCode: courseError?.code ?? 'native_route_restore_failed',
            ...(courseError?.blocker ? { blocker: courseError.blocker } : {})
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async acknowledgement(): Promise<CourseAcknowledgement | undefined> {
    const acknowledgement = this.snapshot.acknowledgement
    if (!acknowledgement) return undefined
    return { ...acknowledgement, activation: await this.activation(), mapReadiness: this.snapshot.mapReadiness?.revision === this.snapshot.desired?.revision ? this.snapshot.mapReadiness?.status ?? 'unknown' : 'unknown' }
  }
  // One durable marker for every observed activation/advance. Never use page
  // load time, a packet receipt time, or an old race-plan timestamp as leg start.
  async observeLeg(now = Date.now(), activation = false): Promise<void> {
    await this.exclusive(async () => {
      const desired = this.snapshot.desired
      const native = await this.native.current()
      const matches = desired?.action === 'activate' && await this.native.matches(desired)
      const points = desired?.action === 'activate' ? coursePoints(desired) : []
      const index = matches ? native?.activeRoute?.pointIndex : desired?.action === 'activate' ? desired.activeWaypointIndex ?? 1 : null
      const identity = desired?.action === 'activate' && Number.isInteger(index) && index! >= 0 && index! < points.length
        ? JSON.stringify([desired.courseId, desired.revision, desired.updatedAt, index, matches ? native?.activeRoute?.href : 'cached', matches && native?.activeRoute?.reverse === true, points]) : null
      if (!activation && (identity === this.snapshot.legStart?.identity || (!identity && !this.snapshot.legStart))) return
      // A first attachment to an already active route cannot reconstruct its
      // activation. Controlled activation or an observed transition is required.
      const knownEvent = activation || !!this.snapshot.legStart
      const fix = this.latestLegPosition
      const baseline = knownEvent && fix && fix.at <= now && now-fix.at <= 30000 ? fix : null
      const next = { ...this.snapshot, legStart: identity ? { identity, observedAt: now, startedAt: knownEvent ? now : null,
        position: baseline?.position ?? null, positionTimestamp: baseline?.at ?? null } : undefined }
      await this.persist(next)
      this.snapshot = next
    })
  }

  observeLegPosition(position: unknown, timestamp: unknown, now = Date.now()): Promise<void> {
    return this.exclusive(async () => {
      const p = position as { latitude?: number; longitude?: number } | null
      const at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
      if (!p || typeof p.latitude !== 'number' || typeof p.longitude !== 'number'
        || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180
        || !Number.isFinite(at) || at > now || now - at > 30000 || (this.latestLegPosition && at <= this.latestLegPosition.at)) return
      this.latestLegPosition = { position: { latitude: p.latitude, longitude: p.longitude }, at }

    })
  }

  async status(): Promise<object> {
    await this.observeLeg()
    const course = this.snapshot.cachedCourse
    const native = await this.native.current()
    const activation = await this.activation()
    const activeMatchesDesired = !!course && this.snapshot.desired?.action === 'activate' && await this.native.matches(course)
    return {
      desired: this.snapshot.desired ?? null, cachedCourse: course ?? null,
      legStart: this.snapshot.legStart ?? null,
      acknowledgement: await this.acknowledgement() ?? null,
      routePoints: course ? coursePoints(course) : [],
      native: {
        available: this.native.available(), course: native,
        ownedRouteId: course ? nativeRouteId(course.courseId) : null,
        activeMatchesDesired, conflict: activation === 'conflict',
        blocker: course && this.snapshot.desired?.action === 'activate' && !activeMatchesDesired
          ? await this.native.classifyConflict(course) : null
      }
    }
  }

  receive(payload: Buffer): Promise<CourseAcknowledgement> {
    let activated = false
    return this.exclusive(async () => {
      let document: CourseDocument
      try {
        document = parseCourse(payload)
        const previous = this.snapshot.desired
        if (previous && document.revision < previous.revision) throw new CourseError('course_revision_rollback')
        if (previous && document.revision === previous.revision && JSON.stringify(previous) !== JSON.stringify(document)) throw new CourseError('course_revision_conflict')
        const duplicate = previous?.revision === document.revision && this.snapshot.acknowledgement?.status === 'applied'
        const previousCourse = this.snapshot.cachedCourse
        // Persist the accepted desired document before any navigation action.
        const next: Snapshot = { ...this.snapshot, desired: document, cachedCourse: document.action === 'activate' ? document : previousCourse, acknowledgement: undefined }
        await this.persist(next)
        this.snapshot = next
        if (document.action === 'clear') await this.native.clearOwned(previousCourse)
        else {
          await this.native.ensureResource(document)
          if (!duplicate) {
            const result = await this.native.activate(document, false, previousCourse)
            activated = result === 'active' || previous?.revision !== document.revision
          }
        }
        const activation = await this.activation()
        const blocker = activation === 'conflict' && document.action === 'activate'
          ? await this.native.classifyConflict(document) : null
        const acknowledgement: CourseAcknowledgement = {
          v: 1, revision: document.revision, status: 'applied', activation,
          ...(blocker ? { blocker } : {})
        }
        await this.persist({ ...this.snapshot, acknowledgement })
        this.snapshot.acknowledgement = acknowledgement
        return acknowledgement
      } catch (error) {
        const courseError = error instanceof CourseError ? error : undefined
        const acknowledgement: CourseAcknowledgement = {
          v: 1, revision: extractRevision(payload), status: 'rejected',
          errorCode: courseError?.code ?? 'native_course_failed', activation: await this.activation(),
          ...(courseError?.blocker ? { blocker: courseError.blocker } : {})
        }
        await this.persist({ ...this.snapshot, acknowledgement })
        this.snapshot.acknowledgement = acknowledgement
        return acknowledgement
      }
    }).then(async acknowledgement => { await this.observeLeg(Date.now(), activated); return acknowledgement })
  }

  activate(): Promise<void> {
    return this.exclusive(async () => {
      const course = this.snapshot.cachedCourse
      if (!course || this.snapshot.desired?.action !== 'activate') throw new CourseError('no_selected_course')
      // Explicit activation replaces an unowned or malformed resource parked at
      // our own deterministic target id. This is the crew-initiated path; it
      // never runs implicitly and never touches unrelated route ids.
      await this.native.ensureResource(course, { explicit: true })
      await this.native.activate(course, true)
      const acknowledgement: CourseAcknowledgement = { v: 1, revision: course.revision, status: 'applied', activation: 'active' }
      await this.persist({ ...this.snapshot, acknowledgement })
      this.snapshot.acknowledgement = acknowledgement
    }).then(async () => { await this.observeLeg(Date.now(), true) })
  }

  setMapReadiness(revision: unknown, status: unknown): Promise<void> {
    return this.exclusive(async () => {
      if (revision !== this.snapshot.desired?.revision || !Number.isSafeInteger(revision)) throw new CourseError('course_revision_conflict')
      if (typeof status !== 'string' || !['unknown', 'unavailable', 'online_only', 'preparing', 'offline_ready'].includes(status)) throw new CourseError('map_readiness_invalid')
      const next: Snapshot = { ...this.snapshot, mapReadiness: { revision: revision as number, status: status as MapReadiness } }
      await this.persist(next)
      this.snapshot = next
    })
  }

  async close(): Promise<void> { await this.operation }
  private async activation(): Promise<'active' | 'inactive' | 'conflict'> {
    const course = this.snapshot.cachedCourse
    if (course && this.snapshot.desired?.action === 'activate' && await this.native.matches(course)) return 'active'
    return (await this.native.current())?.activeRoute?.href ? 'conflict' : 'inactive'
  }
  private async persist(value: Snapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 })
    const temporary = `${this.target}.tmp`
    const handle = await fs.open(temporary, 'w', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, this.target)
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(this.target), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }
}
function extractRevision(payload: Buffer): number {
  if (payload.length > 64 * 1024) return 0
  try {
    const value = JSON.parse(payload.toString('utf8')) as { revision?: number }
    return Number.isSafeInteger(value.revision) && (value.revision ?? 0) > 0 ? value.revision! : 0
  } catch { return 0 }
}
