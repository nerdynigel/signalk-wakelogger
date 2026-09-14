export interface CoursePoint { id: string; name: string; latitude: number; longitude: number; notes?: string }
export interface ActiveCourseDocument {
  v: 1
  action: 'activate'
  revision: number
  courseId: string
  racePlanId?: number
  name: string
  updatedAt: string
  start: CoursePoint
  marks: CoursePoint[]
  finish: CoursePoint
  activeWaypointIndex?: number
}
export interface ClearCourseDocument { v: 1; action: 'clear'; revision: number; courseId: null; updatedAt: string }
export type CourseDocument = ActiveCourseDocument | ClearCourseDocument
export type MapReadiness = 'unknown' | 'unavailable' | 'online_only' | 'preparing' | 'offline_ready'
export interface CourseAcknowledgement {
  mapReadiness?: MapReadiness
  v: 1
  revision: number
  status: 'applied' | 'rejected'
  errorCode?: string
  activation?: 'active' | 'inactive' | 'conflict'
}
export class CourseError extends Error {
  constructor(readonly code: string) { super(code) }
}
export function coursePoints(course: ActiveCourseDocument): CoursePoint[] { return [course.start, ...course.marks, course.finish] }
export function parseCourse(payload: Buffer): CourseDocument {
  if (payload.length > 64 * 1024) throw new CourseError('course_too_large')
  let value: unknown
  try { value = JSON.parse(payload.toString('utf8')) } catch { throw new CourseError('course_invalid_json') }
  const doc = value as Partial<ActiveCourseDocument> | undefined
  if (!doc || doc.v !== 1 || !Number.isSafeInteger(doc.revision) || (doc.revision ?? 0) < 1
    || typeof doc.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(doc.updatedAt) || !Number.isFinite(Date.parse(doc.updatedAt))) throw new CourseError('course_invalid')
  if ((doc as { action?: string }).action === 'clear') {
    if (doc.courseId !== null) throw new CourseError('course_invalid')
    return { v: 1, action: 'clear', revision: doc.revision!, courseId: null, updatedAt: doc.updatedAt }
  }
  if (doc.action !== 'activate' || !validText(doc.courseId, 120) || !validText(doc.name, 255)
    || !Array.isArray(doc.marks) || doc.marks.length > 198 || !validPoint(doc.start) || !validPoint(doc.finish)
    || !doc.marks.every(validPoint)) throw new CourseError('course_invalid')
  const points = [doc.start, ...doc.marks, doc.finish]
  if (new Set(points.map((point) => point.id)).size !== points.length) throw new CourseError('course_duplicate_point_id')
  if (doc.activeWaypointIndex !== undefined && (!Number.isSafeInteger(doc.activeWaypointIndex)
    || doc.activeWaypointIndex < 0 || doc.activeWaypointIndex >= points.length)) throw new CourseError('course_invalid_point_index')
  return {
    v: 1, action: 'activate', revision: doc.revision!, courseId: doc.courseId!, name: doc.name!, updatedAt: doc.updatedAt,
    start: point(doc.start!), marks: doc.marks.map(point), finish: point(doc.finish!),
    ...(Number.isSafeInteger(doc.racePlanId) ? { racePlanId: doc.racePlanId } : {}),
    ...(doc.activeWaypointIndex !== undefined ? { activeWaypointIndex: doc.activeWaypointIndex } : {})
  }
}
function point(value: CoursePoint): CoursePoint { return { id: value.id, name: value.name, latitude: value.latitude, longitude: value.longitude, ...(value.notes !== undefined ? { notes: value.notes } : {}) } }
function validText(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum }
function validPoint(value: unknown): value is CoursePoint {
  const candidate = value as CoursePoint | undefined
  return !!candidate && validText(candidate.id, 120) && validText(candidate.name, 255)
    && (candidate.notes === undefined || (typeof candidate.notes === 'string' && candidate.notes.length <= 1000))
    && Number.isFinite(candidate.latitude) && Math.abs(candidate.latitude) <= 90
    && Number.isFinite(candidate.longitude) && Math.abs(candidate.longitude) <= 180
}
