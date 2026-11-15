import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CourseStore } from '../../src/courses/course-store'
import { NativeCourseService, nativeRouteHref, nativeRouteId, type NativeCourse, type NativeCourseApp } from '../../src/courses/native-course'
import { parseCourse, type ActiveCourseDocument } from '../../src/courses/protocol'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
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

  it('replaces its active owned route when a different race plan arrives', async () => {
    const { store, app } = await fixture()
    await store.receive(encoded({ ...document(2), courseId: 'race-plan-16', racePlanId: 16, name: 'SAGS 27/09/2026' }))
    expect(await store.receive(encoded({ ...document(3), courseId: 'race-plan-19', racePlanId: 19, name: 'SAGS 04/10/2026' })))
      .toMatchObject({ revision: 3, status: 'applied', activation: 'active' })
    expect(app.activateRoute).toHaveBeenLastCalledWith({ href: nativeRouteHref('race-plan-19'), pointIndex: 1, reverse: false })
  })

  it('reconciles its owned previous route after failed desired delivery and restart', async () => {
    const { store, target, native, app } = await fixture()
    await store.receive(encoded({ ...document(2), courseId: 'race-plan-16', racePlanId: 16, name: 'SAGS 27/09/2026' }))
    const today = { ...document(3), courseId: 'race-plan-19', racePlanId: 19, name: 'SAGS 04/10/2026' }
    vi.mocked(app.resourcesApi!.setResource).mockImplementationOnce(() => { throw new Error('write failed') })
    expect(await store.receive(encoded(today))).toMatchObject({ status: 'rejected', revision: 3 })
    const restarted = new CourseStore(target, native)
    await restarted.open()
    expect(await restarted.receive(encoded(today))).toMatchObject({ status: 'applied', activation: 'active', revision: 3 })
    expect(await restarted.status()).toMatchObject({ desired: { racePlanId: 19 }, native: { activeMatchesDesired: true } })
  })

  it('does not trust ownership metadata on an arbitrary foreign route ID', async () => {
    const { store, resources, setNative, app } = await fixture()
    resources.set('foreign', { feature: { properties: { wakelogger: { courseId: 'race-plan-16' } } } })
    setNative({ activeRoute: { href: '/resources/routes/foreign' } })
    expect(await store.receive(encoded(document(3)))).toMatchObject({ status: 'applied', activation: 'conflict' })
    expect(app.activateRoute).not.toHaveBeenCalled()
    await store.activate()
    expect(await store.acknowledgement()).toMatchObject({ status: 'applied', activation: 'active' })
  })

  it('does not overwrite an unrelated resource even at the deterministic ID', async () => {
    const { store, resources, app } = await fixture()
    resources.set(nativeRouteId('race-plan-123'), { name: 'Unrelated route', feature: { properties: {} } })
    const ack = await store.receive(encoded(document()))
    expect(ack).toMatchObject({ status: 'rejected', errorCode: 'native_route_conflict' })
    expect(ack.blocker).toMatchObject({ kind: 'malformed_target', resourceId: nativeRouteId('race-plan-123'), name: 'Unrelated route' })
    expect(app.resourcesApi?.setResource).not.toHaveBeenCalled()
    expect(app.activateRoute).not.toHaveBeenCalled()
  })

  it('explicit activation replaces an unowned resource at the deterministic target id', async () => {
    const { store, resources, app } = await fixture()
    // A synthetic unowned but well-formed resource parked at our target route id.
    resources.set(nativeRouteId('race-plan-123'), { name: 'Synthetic unowned route', feature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[153, -27], [153.01, -27.01]] }, properties: {} } })
    expect(await store.receive(encoded(document()))).toMatchObject({ status: 'rejected', errorCode: 'native_route_conflict' })
    expect(app.activateRoute).not.toHaveBeenCalled()
    // Explicit activation is allowed to replace it.
    await store.activate()
    expect(await store.acknowledgement()).toMatchObject({ status: 'applied', activation: 'active' })
    expect((resources.get(nativeRouteId('race-plan-123')) as any).feature.properties.wakelogger.courseId).toBe('race-plan-123')
    expect(await store.status()).toMatchObject({ native: { activeMatchesDesired: true, conflict: false, blocker: null } })
  })

  it('classifies and replaces a malformed resource at the target id', async () => {
    const { store, resources } = await fixture()
    resources.set(nativeRouteId('race-plan-123'), { feature: { geometry: { type: 'Point', coordinates: [153, -27] } } })
    const ack = await store.receive(encoded(document()))
    expect(ack).toMatchObject({ status: 'rejected' })
    expect(ack.blocker).toMatchObject({ kind: 'malformed_target', resourceId: nativeRouteId('race-plan-123') })
    await store.activate()
    expect(await store.acknowledgement()).toMatchObject({ activation: 'active' })
  })

  it('classifies a foreign active route and names the occupying resource', async () => {
    const { store, resources, setNative } = await fixture()
    resources.set('another-app', { name: 'Harbour route', feature: { geometry: { type: 'LineString', coordinates: [[153, -27], [153.1, -27.1]] } } })
    setNative({ activeRoute: { href: '/resources/routes/another-app', pointIndex: 3 } })
    const ack = await store.receive(encoded(document()))
    expect(ack).toMatchObject({ status: 'applied', activation: 'conflict' })
    expect(ack.blocker).toMatchObject({ kind: 'foreign_active', resourceId: 'another-app', name: 'Harbour route' })
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

describe('durable leg start provenance', () => {
  it('uses activation time with a fresh source baseline and retains it across polling, restart and duplicate delivery', async () => {
    const { store, target, native } = await fixture()
    const at = Date.now()
    const p = { latitude: -27, longitude: 153 }
    await store.observeLegPosition(p, new Date(at).toISOString(), at)
    await store.receive(encoded(document()))
    const baseline = (await store.status() as any).legStart
    expect(baseline.startedAt).toBe(baseline.observedAt)
    expect(baseline.positionTimestamp).toBe(at)
    expect(baseline.position).toEqual(p)
    await store.observeLegPosition({ latitude: -27.005, longitude: 153.005 }, new Date(at + 10000).toISOString(), at + 10000)
    expect((await store.status() as any).legStart).toEqual(baseline)
    const restarted = new CourseStore(target, native)
    await restarted.open()
    expect((await restarted.status() as any).legStart).toEqual(baseline)
    await restarted.receive(encoded(document()))
    expect((await restarted.status() as any).legStart).toEqual(baseline)
  })
  it('does not rebase a leg when activation has no fresh position; old/invalid/future sources cannot seed it', async () => {
    for (const invalid of [null, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: 0 }]) {
      const { store } = await fixture()
      const at = Date.now()
      await store.observeLegPosition(invalid, new Date(at + 5001).toISOString(), at)
      await store.observeLegPosition(invalid, new Date(at - 30001).toISOString(), at)
      await store.receive(encoded(document()))
      const baseline = (await store.status() as any).legStart
      expect(baseline.position).toBeNull()
      await store.observeLegPosition({ latitude: 0, longitude: 0 }, new Date(at + 10000).toISOString(), at + 10000)
      expect((await store.status() as any).legStart).toEqual(baseline)
    }
  })
  it('resets on advance, reverse, route conflict, explicit activation and course revision without changing navigation', async () => {
    const { store, setNative, app } = await fixture()
    await store.receive(encoded(document()))
    let prior = (await store.status() as any).legStart
    for (const route of [{ pointIndex: 2 }, { pointIndex: 2, reverse: true }, { pointIndex: 1, href: '/foreign' }]) {
      const before = prior
      setNative({ activeRoute: { href: nativeRouteHref(document().courseId), ...route } })
      prior = (await store.status() as any).legStart
      expect(prior.identity).not.toEqual(before.identity)
      expect(prior.startedAt).toBe(prior.observedAt)
    }
    await store.activate()
    prior = (await store.status() as any).legStart
    await store.observeLegPosition({ latitude: -27, longitude: 153 }, new Date().toISOString())
    await store.activate()
    expect((await store.status() as any).legStart.position).toEqual({ latitude: -27, longitude: 153 })
    await store.receive(encoded(document(2)))
    expect((await store.status() as any).legStart.identity).not.toEqual(prior.identity)
    await store.receive(encoded({ v: 1, action: 'clear', revision: 3, courseId: null, updatedAt: new Date().toISOString() }))
    expect((await store.status() as any).legStart).toBeNull()
    expect(app.activateRoute).toHaveBeenCalledTimes(4)
  })
  it('an existing route without a saved marker never invents historical activation time', async () => {
    const { store, target, native } = await fixture()
    await store.receive(encoded(document()))
    const stored = JSON.parse(await fs.readFile(target, 'utf8'))
    delete stored.legStart
    await fs.writeFile(target, JSON.stringify(stored))
    const restarted = new CourseStore(target, native)
    await restarted.open()
    expect((await restarted.status() as any).legStart.startedAt).toBeNull()
  })
})


describe('native provider uncertainty', () => {
  it.each([{}, { value: { feature: {} } }, null, [], 'invalid'])('does not overwrite an unknown provider response %j', async value => {
    const { app, native } = await fixture()
    vi.mocked(app.resourcesApi!.getResource).mockResolvedValue(value)
    await expect(native.ensureResource(document())).rejects.toMatchObject({ code: 'native_route_unreadable' })
    expect(app.resourcesApi!.setResource).not.toHaveBeenCalled()
    expect(app.activateRoute).not.toHaveBeenCalled()
  })
  it('allows deliberate explicit activation to repair an unreadable deterministic target', async () => {
    const { app, native, resources } = await fixture()
    resources.set(nativeRouteId(document().courseId), {})
    await expect(native.ensureResource(document())).rejects.toMatchObject({ code: 'native_route_unreadable' })
    expect(app.resourcesApi!.setResource).not.toHaveBeenCalled()
    await native.ensureResource(document(), { explicit: true })
    expect(resources.get(nativeRouteId(document().courseId)).feature.properties.wakelogger.courseId).toBe(document().courseId)
  })

  it('does not treat a transient parse error as permission to write', async () => {
    const { app, native } = await fixture()
    vi.mocked(app.resourcesApi!.getResource).mockRejectedValueOnce(new SyntaxError('Unexpected end of JSON input'))
    await expect(native.ensureResource(document())).rejects.toMatchObject({ code: 'native_route_unreadable' })
    expect(app.resourcesApi!.setResource).not.toHaveBeenCalled()
  })
  it('bounds a hanging read and never writes when the timed out lookup eventually completes', async () => {
    const { app } = await fixture()
    let resolve!: (value: unknown) => void
    vi.mocked(app.resourcesApi!.getResource).mockImplementation(() => new Promise(r => { resolve = r }))
    const native = new NativeCourseService(app, 10)
    await expect(native.ensureResource(document())).rejects.toMatchObject({ code: 'native_course_timeout' })
    resolve({ name: 'Foreign route', feature: {} }); await Promise.resolve()
    expect(app.resourcesApi!.setResource).not.toHaveBeenCalled()
  })
  it('cancels before a queued provider invocation and prevents late reads from activating navigation after close', async () => {
    const { app } = await fixture()
    const native = new NativeCourseService(app)
    const current = native.current(); native.close()
    await expect(current).rejects.toMatchObject({ code: 'native_course_unavailable' })
    expect(app.getCourse).not.toHaveBeenCalled()
    expect(app.activateRoute).not.toHaveBeenCalled()
  })
  it('quarantines a timed-out mutation until the provider actually settles', async () => {
    const { app } = await fixture()
    let resolve!: () => void
    vi.mocked(app.activateRoute!).mockImplementationOnce(() => new Promise<void>(r => { resolve = r }))
    const native = new NativeCourseService(app, 10)
    await expect(native.activate(document(), true)).rejects.toMatchObject({ code: 'native_course_timeout' })
    await expect(native.activate({ ...document(2), courseId: 'another-course' }, true)).rejects.toMatchObject({ code: 'native_course_busy' })
    expect(app.activateRoute).toHaveBeenCalledTimes(1)
    native.close()
    const replacement = new NativeCourseService(app, 10)
    await expect(replacement.activate(document(), true)).rejects.toMatchObject({ code: 'native_course_busy' })
    resolve(); await Promise.resolve(); await Promise.resolve()
    await replacement.activate(document(), true)
    expect(app.activateRoute).toHaveBeenCalledTimes(2)
  })

  it('opens a cached course without waiting for optional native restoration', async () => {
    const f = await fixture()
    await f.store.receive(encoded(document()))
    vi.mocked(f.app.resourcesApi!.getResource).mockImplementation(() => new Promise(() => undefined))
    const fresh = new CourseStore(f.target, new NativeCourseService(f.app, 10))
    await fresh.open({ restoreNative: false })
    const restoration = fresh.restoreNative()
    await restoration
    await fresh.close()
  })
})
