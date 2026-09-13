import { createHash } from 'node:crypto'
import { CourseError, coursePoints, type ActiveCourseDocument } from './protocol'

export interface NativeCourse {
  activeRoute?: { href?: string; pointIndex?: number; pointTotal?: number; reverse?: boolean; name?: string } | null
  nextPoint?: unknown
  previousPoint?: unknown
  startTime?: string
  [key: string]: unknown
}
interface RouteResource {
  name: string
  description: string
  feature: { type: 'Feature'; geometry: { type: 'LineString'; coordinates: number[][] }; properties: { wakelogger: { courseId: string; revision: number }; coordinatesMeta: Array<{ name: string; notes?: string }> } }
}
export interface NativeCourseApp {
  resourcesApi?: {
    getResource: (type: string, id: string) => Promise<unknown>
    setResource: (type: string, id: string, value: unknown) => Promise<unknown> | void
  }
  getCourse?: () => Promise<NativeCourse> | NativeCourse
  activateRoute?: (options: { href: string; pointIndex: number; reverse: boolean }) => Promise<unknown> | void
  clearDestination?: () => Promise<unknown> | void
}

export function nativeRouteId(courseId: string): string {
  const hash = createHash('sha256').update(`signalk-wakelogger:course:${courseId}`).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
export function nativeRouteHref(courseId: string): string { return `/resources/routes/${nativeRouteId(courseId)}` }

export class NativeCourseService {
  constructor(private readonly app: NativeCourseApp) {}
  available(): boolean { return [this.app.resourcesApi?.getResource, this.app.resourcesApi?.setResource, this.app.getCourse, this.app.activateRoute, this.app.clearDestination].every((method) => typeof method === 'function') }
  async current(): Promise<NativeCourse | null> { return this.app.getCourse ? structuredClone(await this.app.getCourse() ?? null) : null }
  async matches(course: ActiveCourseDocument): Promise<boolean> { return (await this.current())?.activeRoute?.href === nativeRouteHref(course.courseId) }

  async ensureResource(course: ActiveCourseDocument): Promise<void> {
    this.assertAvailable()
    const id = nativeRouteId(course.courseId)
    const resource: RouteResource = {
      name: course.name, description: `Wake Logger course ${course.courseId}`,
      feature: {
        type: 'Feature', geometry: { type: 'LineString', coordinates: coursePoints(course).map((point) => [point.longitude, point.latitude]) },
        properties: { wakelogger: { courseId: course.courseId, revision: course.revision }, coordinatesMeta: coursePoints(course).map((point) => ({ name: point.name, ...(point.notes !== undefined ? { notes: point.notes } : {}) })) }
      }
    }
    const existing = await this.readRoute(id)
    if (existing && !ownedBy(existing, course.courseId)) throw new CourseError('native_route_conflict')
    if (JSON.stringify(existing) === JSON.stringify(resource)) return
    await this.app.resourcesApi!.setResource('routes', id, resource)
    // Signal K 2.31's wrapper does not return its provider write promise. Read
    // back the resource before activating, and fail visibly if it never commits.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stored = await this.readRoute(id)
      if (stored && ownedBy(stored, course.courseId)
        && JSON.stringify((stored as RouteResource).feature.geometry) === JSON.stringify(resource.feature.geometry)
        && (stored as RouteResource).feature.properties.wakelogger.revision === course.revision) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new CourseError('native_route_write_unconfirmed')
  }

  async activate(course: ActiveCourseDocument, explicit: boolean, previousCourse?: ActiveCourseDocument): Promise<'active' | 'conflict'> {
    this.assertAvailable()
    const current = (await this.current())?.activeRoute?.href
    const target = nativeRouteHref(course.courseId)
    if (!explicit && current && current !== target) {
      if (!previousCourse || current !== nativeRouteHref(previousCourse.courseId)) return 'conflict'
      const previousResource = await this.readRoute(nativeRouteId(previousCourse.courseId))
      if (!previousResource || !ownedBy(previousResource, previousCourse.courseId)) return 'conflict'
    }
    // Replayed desired state must not reset an ongoing native course's progress.
    if (current === target && !explicit && previousCourse?.revision === course.revision) return 'active'
    const existingIndex = (await this.current())?.activeRoute?.pointIndex
    const pointIndex = current === target && !explicit && Number.isInteger(existingIndex)
      ? Math.min(existingIndex!, coursePoints(course).length - 1)
      : course.activeWaypointIndex ?? Math.min(1, coursePoints(course).length - 1)
    await this.app.activateRoute!({ href: target, pointIndex, reverse: false })
    if (!await this.matches(course)) throw new CourseError('native_activation_unconfirmed')
    return 'active'
  }

  async clearOwned(course?: ActiveCourseDocument): Promise<void> {
    this.assertAvailable()
    if (course && await this.matches(course)) {
      const resource = await this.readRoute(nativeRouteId(course.courseId))
      if (resource && ownedBy(resource, course.courseId)) await this.app.clearDestination!()
    }
  }

  private async readRoute(id: string): Promise<unknown> {
    try { return await this.app.resourcesApi!.getResource('routes', id) }
    catch (error) {
      const failure = error as { status?: number; statusCode?: number; code?: string; message?: string }
      if (/no provider for routes/i.test(failure.message ?? '')) throw new CourseError('native_routes_unavailable')
      if (failure.status === 404 || failure.statusCode === 404 || failure.code === 'ENOENT' || /not found/i.test(failure.message ?? '')) return undefined
      throw error
    }
  }
  private assertAvailable(): void { if (!this.available()) throw new CourseError('native_course_unavailable') }
}
function ownedBy(value: unknown, courseId: string): boolean {
  const candidate = value as Partial<RouteResource>
  return candidate?.feature?.properties?.wakelogger?.courseId === courseId
}
