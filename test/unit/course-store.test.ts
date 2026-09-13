import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CourseStore } from '../../src/courses/course-store'
import { NativeCourseService, nativeRouteHref, nativeRouteId, type NativeCourse, type NativeCourseApp } from '../../src/courses/native-course'
import { parseCourse, type ActiveCourseDocument } from '../../src/courses/protocol'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })
function document(revision = 1): ActiveCourseDocument {
  return { v: 1, action: 'activate', revision, courseId: 'race-plan-123', racePlanId: 123, name: 'Club race', updatedAt: '2026-09-13T00:00:00Z',
    start: { id: 'start', name: 'Start', latitude: -27, longitude: 153 },
    marks: [{ id: 'mark-1', name: 'Windward', latitude: -27.01, longitude: 153.01, notes: 'Leave to port' }],
    finish: { id: 'finish', name: 'Finish', latitude: -27, longitude: 153 }, activeWaypointIndex: 1 }
}
function encoded(value: unknown): Buffer { return Buffer.from(JSON.stringify(value)) }
async function fixture(delayedWrite = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'course-store-'))
  directories.push(directory)
  const target = path.join(directory, 'course.json')
  const resources = new Map<string, any>()
  let course: NativeCourse = { activeRoute: null }
  const app: NativeCourseApp = {
    resourcesApi: {
      getResource: vi.fn(async (_type, id) => { if (!resources.has(id)) throw new Error(`Resource not found! (${id})`); return resources.get(id) }),
      setResource: vi.fn((_type, id, value) => {
        if (delayedWrite) setTimeout(() => resources.set(id, structuredClone(value)), 20)
        else resources.set(id, structuredClone(value))
      })
    },
    getCourse: vi.fn(async () => structuredClone(course)),
    activateRoute: vi.fn(async (options) => { course = { activeRoute: { ...options, pointTotal: 3 } } }),
    clearDestination: vi.fn(async () => { course = { activeRoute: null } })
  }
  const native = new NativeCourseService(app)
  const store = new CourseStore(target, native)
  await store.open()
  return { store, target, native, app, resources, setNative: (value: NativeCourse) => { course = value } }
}

describe('course delivery and native resources', () => {
  it('persists a validated course and waits for native resource write before activating, with named marks', async () => {
    const { store, resources, app } = await fixture(true)
    const ack = await store.receive(encoded(document()))
    expect(ack).toMatchObject({ revision: 1, status: 'applied', activation: 'active' })
    const id = nativeRouteId('race-plan-123')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(resources.get(id).feature).toMatchObject({ geometry: { coordinates: [[153, -27], [153.01, -27.01], [153, -27]] }, properties: { coordinatesMeta: [{ name: 'Start' }, { name: 'Windward', notes: 'Leave to port' }, { name: 'Finish' }] } })
    expect(app.activateRoute).toHaveBeenCalledWith({ href: nativeRouteHref('race-plan-123'), pointIndex: 1, reverse: false })
  })

  it('rejects malformed positions and revisions without replacing the last valid course', async () => {
    const { store } = await fixture()
    await store.receive(encoded(document(3)))
    expect(await store.receive(encoded({ ...document(4), start: { ...document().start, latitude: 91 } }))).toMatchObject({ status: 'rejected', errorCode: 'course_invalid' })
    expect(await store.receive(encoded(document(2)))).toMatchObject({ status: 'rejected', errorCode: 'course_revision_rollback' })
    expect(await store.receive(encoded({ ...document(3), name: 'Conflicting update' }))).toMatchObject({ status: 'rejected', errorCode: 'course_revision_conflict' })
    expect(await store.status()).toMatchObject({ desired: { revision: 3, name: 'Club race' } })
  })

  it('survives restart and duplicate retained delivery without resetting native progress', async () => {
    const { store, target, native, app, setNative } = await fixture()
    await store.receive(encoded(document(3)))
    setNative({ activeRoute: { href: nativeRouteHref('race-plan-123'), pointIndex: 2, pointTotal: 3 } })
    const restarted = new CourseStore(target, native)
    await restarted.open()
    await restarted.receive(encoded(document(3)))
    expect(app.activateRoute).toHaveBeenCalledTimes(1)
    expect(await restarted.status()).toMatchObject({ native: { course: { activeRoute: { pointIndex: 2 } } } })
    expect(await restarted.receive(encoded(document(2)))).toMatchObject({ errorCode: 'course_revision_rollback' })
  })

  it('preserves another app active route and requires explicit local activation', async () => {
    const { store, app, setNative } = await fixture()
    setNative({ activeRoute: { href: '/resources/routes/another-app', pointIndex: 3 } })
    expect(await store.receive(encoded(document()))).toMatchObject({ status: 'applied', activation: 'conflict' })
    expect(app.activateRoute).not.toHaveBeenCalled()
    await store.activate()
    expect(app.activateRoute).toHaveBeenCalledTimes(1)
    expect(await store.status()).toMatchObject({ native: { activeMatchesDesired: true, conflict: false } })
  })

  it('does not overwrite an unrelated resource even at the deterministic ID', async () => {
    const { store, resources, app } = await fixture()
    resources.set(nativeRouteId('race-plan-123'), { name: 'Unrelated route', feature: { properties: {} } })
    expect(await store.receive(encoded(document()))).toMatchObject({ status: 'rejected', errorCode: 'native_route_conflict' })
    expect(app.resourcesApi?.setResource).not.toHaveBeenCalled()
    expect(app.activateRoute).not.toHaveBeenCalled()
  })

  it('updates its route at the current point and clears only its own active navigation', async () => {
    const { store, app, setNative } = await fixture()
    await store.receive(encoded(document()))
    setNative({ activeRoute: { href: nativeRouteHref('race-plan-123'), pointIndex: 2 } })
    await store.receive(encoded({ ...document(2), name: 'Updated course' }))
    expect(app.activateRoute).toHaveBeenLastCalledWith({ href: nativeRouteHref('race-plan-123'), pointIndex: 2, reverse: false })
    setNative({ activeRoute: { href: '/resources/routes/other' } })
    await store.receive(encoded({ v: 1, action: 'clear', courseId: null, revision: 3, updatedAt: document().updatedAt }))
    expect(app.clearDestination).not.toHaveBeenCalled()
    expect(await store.status()).toMatchObject({ desired: { action: 'clear' }, cachedCourse: { revision: 2 } })
  })

  it('reapplies a desired clear on offline restart when native clear was not persisted', async () => {
    const { store, target, native, setNative, app } = await fixture()
    await store.receive(encoded(document()))
    await store.receive(encoded({ v: 1, action: 'clear', courseId: null, revision: 2, updatedAt: document().updatedAt }))
    setNative({ activeRoute: { href: nativeRouteHref('race-plan-123'), pointIndex: 1 } })
    const restarted = new CourseStore(target, native)
    await restarted.open()
    expect(app.clearDestination).toHaveBeenCalledTimes(2)
    expect(await restarted.status()).toMatchObject({ native: { course: { activeRoute: null } } })
  })

  it('persists offline chart readiness separately and rejects reports for an old course revision', async () => {
    const { store, target, native } = await fixture()
    await store.receive(encoded(document()))
    await store.setMapReadiness(1, 'offline_ready')
    const restarted = new CourseStore(target, native)
    await restarted.open()
    expect(await restarted.acknowledgement()).toMatchObject({ revision: 1, mapReadiness: 'offline_ready' })
    await restarted.receive(encoded(document(2)))
    expect(await restarted.acknowledgement()).toMatchObject({ revision: 2, mapReadiness: 'unknown' })
    await expect(restarted.setMapReadiness(1, 'offline_ready')).rejects.toThrow('course_revision_conflict')
  })

  it('enforces message size, coordinate counts and unique mark occurrence IDs', () => {
    expect(() => parseCourse(Buffer.alloc(65537))).toThrow('course_too_large')
    expect(() => parseCourse(encoded({ ...document(), marks: Array(199).fill(document().start) }))).toThrow('course_invalid')
    expect(() => parseCourse(encoded({ ...document(), marks: [document().start] }))).toThrow('course_duplicate_point_id')
  })
})
