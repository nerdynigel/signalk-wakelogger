import { promises as fs } from 'node:fs'
import path from 'node:path'
import { NativeCourseService, nativeRouteId } from './native-course'
import { CourseError, coursePoints, parseCourse, type ActiveCourseDocument, type CourseAcknowledgement, type CourseDocument, type MapReadiness } from './protocol'

interface Snapshot { version: 1; mapReadiness?: { revision: number; status: MapReadiness }; desired?: CourseDocument; cachedCourse?: ActiveCourseDocument; acknowledgement?: CourseAcknowledgement }

export class CourseStore {
  private snapshot: Snapshot = { version: 1 }
  private operation: Promise<void> = Promise.resolve()
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
        catch { this.snapshot.acknowledgement = { v: 1, revision: stored.desired?.revision ?? stored.cachedCourse.revision, status: 'rejected', errorCode: 'native_route_restore_failed' } }
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
  async status(): Promise<object> {
    const course = this.snapshot.cachedCourse
    const native = await this.native.current()
    return {
      desired: this.snapshot.desired ?? null, cachedCourse: course ?? null,
      acknowledgement: await this.acknowledgement() ?? null,
      routePoints: course ? coursePoints(course) : [],
      native: {
        available: this.native.available(), course: native,
        ownedRouteId: course ? nativeRouteId(course.courseId) : null,
        activeMatchesDesired: !!course && this.snapshot.desired?.action === 'activate' && await this.native.matches(course), conflict: await this.activation() === 'conflict'
      }
    }
  }

  receive(payload: Buffer): Promise<CourseAcknowledgement> {
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
          if (!duplicate) await this.native.activate(document, false, previousCourse)
        }
        const acknowledgement: CourseAcknowledgement = { v: 1, revision: document.revision, status: 'applied', activation: await this.activation() }
        await this.persist({ ...this.snapshot, acknowledgement })
        this.snapshot.acknowledgement = acknowledgement
        return acknowledgement
      } catch (error) {
        const acknowledgement: CourseAcknowledgement = { v: 1, revision: extractRevision(payload), status: 'rejected', errorCode: error instanceof CourseError ? error.code : 'native_course_failed', activation: await this.activation() }
        await this.persist({ ...this.snapshot, acknowledgement })
        this.snapshot.acknowledgement = acknowledgement
        return acknowledgement
      }
    })
  }

  activate(): Promise<void> {
    return this.exclusive(async () => {
      const course = this.snapshot.cachedCourse
      if (!course || this.snapshot.desired?.action !== 'activate') throw new CourseError('no_selected_course')
      await this.native.ensureResource(course)
      await this.native.activate(course, true)
      const acknowledgement: CourseAcknowledgement = { v: 1, revision: course.revision, status: 'applied', activation: 'active' }
      await this.persist({ ...this.snapshot, acknowledgement })
      this.snapshot.acknowledgement = acknowledgement
    })
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
