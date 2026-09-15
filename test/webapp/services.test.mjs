import test from 'node:test'
import assert from 'node:assert/strict'
import { chartSources, courseBounds, coversBounds } from '../../webapp/chart-sources.mjs'
import { raceProgress } from '../../webapp/course-progress.mjs'
import { CourseProgressionService } from '../../webapp/api-client.mjs'

const origin = 'http://boat.local:3000'
const point = (latitude, longitude) => ({ latitude, longitude })

test('chart discovery preserves native tile coordinates and prioritizes local charts', () => {
  const sources = chartSources({
    remote: { name: 'Online', type: 'tilelayer', url: 'https://maps.example/{z}/{x}/{y}.png', format: 'png' },
    proxy: { name: 'Proxy', type: 'tilelayer', url: '/signalk/chart-tiles/proxy/{z}/{x}/{y}', proxy: true },
    local: { name: 'MBTiles', type: 'tilelayer', url: '/signalk/chart-tiles/local/{z}/{x}/{y}', proxy: false, bounds: [153, -28, 154, -27], minzoom: 4, maxzoom: 16 },
    legacy: { type: 'tilelayer', tilemapUrl: '/legacy/{z}/{x}/{-y}', format: 'jpg' },
    credentials: { type: 'tilelayer', url: 'https://user:secret@maps.example/tiles' },
    javascript: { type: 'tilelayer', url: 'javascript:alert(1)' },
    vector: { type: 'tilelayer', url: '/tiles/{z}/{x}/{y}', format: 'pbf' },
  }, origin)
  assert.deepEqual(sources.map((source) => source.id), ['local', 'proxy', 'legacy', 'remote'])
  assert.equal(sources[0].local, true)
  assert.equal(sources[0].url, '/signalk/chart-tiles/local/{z}/{x}/{y}')
  assert.equal(sources[0].minZoom, 4)
  assert.equal(sources[0].maxZoom, 16)
  assert.equal(sources[1].cached, true)
  assert.equal(sources[3].online, true)
})

test('course preparation bounds include requested margin and reject world-spanning jobs', () => {
  const bounds = courseBounds([point(-27.4, 153.1), point(-27.3, 153.2)], 10)
  assert.ok(bounds[0] < 153.1 && bounds[1] < -27.4 && bounds[2] > 153.2 && bounds[3] > -27.3)
  assert.equal(coversBounds({ bounds: [152, -28, 154, -27] }, bounds), true)
  assert.equal(coversBounds({ bounds: [153.1, -27.4, 153.2, -27.3] }, bounds), false)
  assert.equal(courseBounds([point(0, 179.9), point(0, -179.9)], 10), null)
  assert.equal(courseBounds([point(-27, 153)], 100), null)
  assert.equal(courseBounds([point(NaN, 153)], 10), null)
})

test('native calculations are converted from SI without fabricating missing values', () => {
  const status = { cachedCourse: { start: point(-27.4, 153.1), marks: [point(-27.3, 153.2)], finish: point(-27.2, 153.1) }, native: { activeMatchesDesired: true, course: { activeRoute: { pointIndex: 1 } } } }
  const progress = raceProgress(status, { position: { value: point(-27.35, 153.15) }, courseOverGroundTrue: { value: Math.PI / 2 } }, { distance: 1852, bearingTrue: Math.PI, velocityMadeGood: 0.5144444444, crossTrackError: -12, timeToGo: 60 })
  assert.equal(progress.distanceNm, 1)
  assert.equal(progress.bearingDeg, 180)
  assert.equal(progress.direction, 90)
  assert.equal(progress.vmgKn, 1)
  assert.equal(progress.xteM, -12)
  assert.equal(progress.timeToGo, 60)
  assert.equal(progress.pointPercent, 50)
  assert.equal(progress.eta, null)
  const conflict = raceProgress({ ...status, native: { ...status.native, activeMatchesDesired: false } }, {}, { distance: 1852 })
  assert.equal(conflict.next, null)
  assert.equal(conflict.distanceNm, null)
  assert.equal(conflict.index, null)
})

test('invalid native point indices cannot issue a request', async () => {
  const requests = []
  const service = new CourseProgressionService({ request: (...args) => { requests.push(args); return Promise.resolve() } })
  for (const index of [-1, 3, 1.2, NaN]) await assert.rejects(service.setPoint(index, 3), /valid course point/)
  assert.equal(requests.length, 0)
  await service.setPoint(0, 3)
  assert.equal(requests[0][0], '/signalk/v2/api/vessels/self/navigation/course/activeRoute/pointIndex')
  assert.equal(requests[0][1].method, 'PUT')
  assert.deepEqual(JSON.parse(requests[0][1].body), { value: 0 })
})

test('local chart verification guards request count, reuses checked tiles, and supports cancellation', async () => {
  const { LocalChartVerifier, tilePlan } = await import('../../webapp/map-preparation.mjs')
  assert.throws(() => tilePlan([-180, -80, 180, 80], 8, 12), /exceeds/)
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }) }
  try {
    const chart = { local: true, type: 'tilelayer', url: '/signalk/chart-tiles/bay/{z}/{x}/{y}', minZoom: 1, maxZoom: 1 }
    const bounds = [-1, -1, 1, 1]
    const verifier = new LocalChartVerifier()
    const result = await verifier.verify(chart, bounds, { minZoom: 1, maxZoom: 1 })
    assert.equal(result.total, 4)
    assert.equal(result.bytes, 12)
    assert.equal(requests, 4)
    await verifier.verify(chart, bounds, { minZoom: 1, maxZoom: 1 })
    assert.equal(requests, 4)
    await assert.rejects(verifier.verify({ ...chart, local: false }, bounds), /local raster chart/)
    await assert.rejects(verifier.verify(chart, bounds, { minZoom: 1, maxZoom: 1, onProgress: () => verifier.cancel() }), { name: 'AbortError' })
    assert.equal(requests, 4)
  } finally { globalThis.fetch = originalFetch }
})

test('chart verification refuses missing tiles and enforces the byte ceiling', async () => {
  const { LocalChartVerifier } = await import('../../webapp/map-preparation.mjs')
  const originalFetch = globalThis.fetch
  const chart = { local: true, type: 'tilelayer', url: '/signalk/chart-tiles/bay/{z}/{x}/{y}', minZoom: 1, maxZoom: 1 }
  try {
    globalThis.fetch = async () => new Response('', { status: 404 })
    await assert.rejects(new LocalChartVerifier().verify(chart, [-1, -1, 1, 1], { minZoom: 1, maxZoom: 1 }), /unavailable/)
    globalThis.fetch = async () => new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } })
    await assert.rejects(new LocalChartVerifier().verify(chart, [-1, -1, 1, 1], { minZoom: 1, maxZoom: 1, maxBytes: 1024 * 1024 }), /limit reached/)
  } finally { globalThis.fetch = originalFetch }
})


test('native route changed at another station prevents stale commands', async () => {
  const requests = []
  const service = new CourseProgressionService({ request: (...args) => { requests.push(args); return Promise.resolve({ activeRoute: { href: '/resources/routes/other' } }) } })
  await assert.rejects(service.advance('/resources/routes/owned'), /Another course/)
  await assert.rejects(service.setPoint(1, 3, '/resources/routes/owned'), /Another course/)
  assert.equal(requests.length, 2)
  assert.ok(requests.every(([url, options]) => url.endsWith('/navigation/course') && !options))
})

test('proxied WMS and WMTS use the native XYZ endpoint', () => {
  const sources = chartSources({
    wms: { type: 'WMS', url: '/signalk/chart-tiles/wms/{z}/{x}/{y}', proxy: true },
    wmts: { type: 'WMTS', url: '/signalk/chart-tiles/wmts/{z}/{x}/{y}', proxy: true },
    direct: { type: 'WMS', url: 'https://maps.example/wms', layers: 'depth' },
  }, origin)
  assert.equal(sources.find((source) => source.id === 'wms').type, 'tilelayer')
  assert.equal(sources.find((source) => source.id === 'wmts').type, 'tilelayer')
  assert.equal(sources.find((source) => source.id === 'direct').type, 'WMS')
})

test('validated native route geometry wins over cached cloud coordinates', () => {
  const cachedCourse = { action: 'activate', start: { ...point(-27, 153), name: 'Old start' }, finish: { ...point(-28, 154), name: 'Old finish' } }
  const status = { cachedCourse, native: { activeMatchesDesired: true, course: { activeRoute: { pointIndex: 1 } } } }
  const nativeRoute = { feature: { geometry: { type: 'LineString', coordinates: [[153.1, -27.1], [153.2, -27.2]] }, properties: { coordinatesMeta: [{ name: 'Native start' }, { name: 'Native finish' }] } } }
  const progress = raceProgress(status, {}, {}, nativeRoute)
  assert.equal(progress.routeSource, 'signalk')
  assert.equal(progress.next.name, 'Native finish')
  assert.equal(progress.next.latitude, -27.2)
  assert.equal(progress.next.longitude, 153.2)
  assert.equal(raceProgress(status, {}, {}, null).next.name, 'Old finish')
  assert.equal(raceProgress(status, {}, {}, { feature: { geometry: { type: 'LineString', coordinates: [[0, 0], [999, 99]] } } }).routeSource, 'cached')
})

test('cleared desired course cannot be resurrected by cached or native geometry', () => {
  const status = { desired: { action: 'clear' }, cachedCourse: { start: point(-27, 153), finish: point(-28, 154) }, native: { activeMatchesDesired: true, course: { activeRoute: { pointIndex: 1 } } } }
  const nativeRoute = { feature: { geometry: { type: 'LineString', coordinates: [[153, -27], [154, -28]] } } }
  const progress = raceProgress(status, {}, { distance: 1852 }, nativeRoute)
  assert.deepEqual(progress.points, [])
  assert.equal(progress.next, null)
  assert.equal(progress.matches, false)
  assert.equal(progress.distanceNm, null)
})

test('reversed native routes index from finish toward start', () => {
  const cachedCourse = { start: { ...point(-27, 153), name: 'Start' }, marks: [{ ...point(-27.5, 153.5), name: 'Mark' }], finish: { ...point(-28, 154), name: 'Finish' } }
  const at = (pointIndex) => raceProgress({ cachedCourse, native: { activeMatchesDesired: true, course: { activeRoute: { pointIndex, reverse: true } } } })
  assert.equal(at(0).next.name, 'Finish')
  assert.equal(at(0).previous, null)
  assert.equal(at(0).pointPercent, 0)
  assert.equal(at(1).next.name, 'Mark')
  assert.equal(at(1).previous.name, 'Finish')
  assert.equal(at(2).next.name, 'Start')
  assert.equal(at(2).previous.name, 'Mark')
  assert.equal(at(2).pointPercent, 100)
  assert.equal(at(0).direction, null)
})

test('tracking status distinguishes local recording, disconnected live intent, and unpaired state', async () => {
  const { trackingPresentation } = await import('../../webapp/tracking-controls.mjs')
  const snapshot = { paired: true, recording: true, uploadMode: 'local_only', queue: { messageCount: 12 } }
  assert.equal(trackingPresentation(snapshot).enabled, false)
  assert.match(trackingPresentation(snapshot).description, /Recording locally/)
  assert.equal(trackingPresentation({ ...snapshot, uploadMode: 'automatic', connectionState: 'offline' }).mode, 'Waiting for internet')
  assert.equal(trackingPresentation({ ...snapshot, paired: false }).available, false)
  assert.equal(trackingPresentation(null).available, false)
  assert.equal(trackingPresentation({ ...snapshot, queue: { messageCount: 0 } }).queue, 'Upload queue empty')
})


test('tracking controls honor runtime availability and revoked device access', async () => {
  const { trackingPresentation } = await import('../../webapp/tracking-controls.mjs')
  const snapshot = { paired: true, recording: true, uploadMode: 'local_only' }
  assert.equal(trackingPresentation(snapshot).available, true)
  for (const unavailable of [{ available: false }, { recording: false }, { connectionState: 'device_revoked' }]) {
    const result = trackingPresentation({ ...snapshot, ...unavailable })
    assert.equal(result.available, false)
    assert.notEqual(result.mode, 'Not paired')
    assert.match(result.description, /unavailable|revoked/)
  }
  assert.equal(trackingPresentation({ ...snapshot, available: true }).available, true)
})
