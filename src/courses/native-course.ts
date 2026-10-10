import { createHash } from 'node:crypto'
import { CourseError, coursePoints, type ActiveCourseDocument, type CourseBlocker } from './protocol'

export interface NativeCourse {
  activeRoute?: { href?: string; pointIndex?: number; pointTotal?: number; reverse?: boolean; name?: string } | null
  nextPoint?: unknown
  previousPoint?: unknown
  startTime?: string
  [key: string]: unknown
}

export interface DescribedResource {
  id: string
  name: string | null
  owner: string | null
  malformed: boolean
  /** The Wake Logger course id recorded on the resource, when readable. */
  courseId: string | null
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

  async ensureResource(course: ActiveCourseDocument, options: { explicit?: boolean } = {}): Promise<void> {
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
    if (existing && !ownedBy(existing, course.courseId)) {
      // Implicit sync (delivery/replay/restart) must never clobber a foreign or
      // unowned resource. Explicit activation is the only path allowed to
      // replace an unowned or malformed resource parked at our own target id.
      if (!options.explicit) throw new CourseError('native_route_conflict', targetBlocker(id, existing))
    }
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
      // cachedCourse is the accepted desired document, so a failed delivery or
      // restart can already have replaced the previous identity. Establish
      // ownership from the native resource and deterministic ID instead.
      const activeId = current.match(/^\/resources\/routes\/([^/]+)$/)?.[1]
      if (!activeId) return 'conflict'
      const activeResource = await this.readRoute(activeId)
      const ownedCourseId = (activeResource as Partial<RouteResource>)?.feature?.properties?.wakelogger?.courseId
      if (typeof ownedCourseId !== 'string' || current !== nativeRouteHref(ownedCourseId)
        || !ownedBy(activeResource, ownedCourseId)) return 'conflict'
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

  // Reads a route resource and yields a bounded, credential-safe description
  // for diagnostics. Never throws for an ordinary missing resource.
  async describeResource(id: string): Promise<DescribedResource | null> {
    if (!this.app.resourcesApi?.getResource) return null
    let value: unknown
    try { value = await this.readRoute(id) } catch { return null }
    if (value === undefined || value === null) return null
    return describeRoute(id, value)
  }

  // Classifies why the desired course is not active, so the acknowledgement can
  // name the exact blocker and occupying resource. Returns null when nothing is
  // blocking (the route is ready or already active).
  async classifyConflict(course: ActiveCourseDocument): Promise<CourseBlocker | null> {
    const current = (await this.current())?.activeRoute?.href
    const target = nativeRouteHref(course.courseId)
    if (current && current !== target) {
      const id = current.match(/^\/resources\/routes\/([^/]+)$/)?.[1] ?? current
      const described = await this.describeResource(id)
      return { kind: 'foreign_active', resourceId: id, name: described?.name ?? null, owner: described?.owner ?? null }
    }
    const targetId = nativeRouteId(course.courseId)
    const described = await this.describeResource(targetId)
    if (described && described.courseId !== course.courseId) {
      return { kind: described.malformed ? 'malformed_target' : 'occupied_target', resourceId: described.id, name: described.name, owner: described.owner }
    }
    return null
  }

  private async readRoute(id: string): Promise<unknown> {
    try { return await this.app.resourcesApi!.getResource('routes', id) }
    catch (error) {
      const failure = error as { status?: number; statusCode?: number; code?: string; message?: string }
      if (/no provider for routes/i.test(failure.message ?? '')) throw new CourseError('native_routes_unavailable')
      if (failure.status === 404 || failure.statusCode === 404 || failure.code === 'ENOENT' || /not found/i.test(failure.message ?? '')) return undefined
      // Signal K 2.31's file-backed resource provider can briefly expose a
      // partial file while its write settles (an empty/incomplete JSON read).
      // Treat that transient state as "not readable yet" so the ensureResource
      // read-back loop retries instead of rejecting the whole course with a 409.
      if (error instanceof SyntaxError || /unexpected end of json|unexpected token|invalid json|not readable|EBUSY|EAGAIN/i.test(failure.message ?? '')) return undefined
      throw error
    }
  }
  private assertAvailable(): void { if (!this.available()) throw new CourseError('native_course_unavailable') }
}
function ownedBy(value: unknown, courseId: string): boolean {
  const candidate = value as Partial<RouteResource>
  return candidate?.feature?.properties?.wakelogger?.courseId === courseId
}
function readableText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/[\r\n\t]+/g, ' ').trim()
  return trimmed ? trimmed.slice(0, maximum) : null
}
function describeRoute(id: string, value: unknown): DescribedResource {
  const candidate = value as {
    name?: unknown
    feature?: { geometry?: { type?: unknown; coordinates?: unknown }; properties?: Record<string, unknown> }
  }
  const properties = candidate?.feature?.properties ?? {}
  const wakelogger = properties.wakelogger as { courseId?: unknown } | undefined
  const courseId = readableText(wakelogger?.courseId, 120)
  const ownerProp = readableText(properties.owner, 255)
  const owner = ownerProp ?? (courseId ? `Wake Logger course ${courseId}` : null)
  const geometry = candidate?.feature?.geometry
  const malformed = !(geometry?.type === 'LineString' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2)
  return { id, name: readableText(candidate?.name, 255), owner, malformed, courseId }
}
function targetBlocker(id: string, value: unknown): CourseBlocker {
  const described = describeRoute(id, value)
  return { kind: described.malformed ? 'malformed_target' : 'occupied_target', resourceId: id, name: described.name, owner: described.owner }
}
