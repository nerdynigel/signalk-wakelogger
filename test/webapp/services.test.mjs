import test from 'node:test'
import assert from 'node:assert/strict'
import { chartSources, courseBounds, coversBounds } from '../../webapp/chart-sources.mjs'
import { raceProgress } from '../../webapp/course-progress.mjs'
import { CourseProgressionService, SignalKRequestError, boundedDetail, parseSignalKError } from '../../webapp/api-client.mjs'
import { describeNavigationFailure } from '../../webapp/navigation-errors.mjs'
import { offlineReadinessPresentation, localOnlyWarning } from '../../webapp/offline-readiness.mjs'
import { instrumentReadings, formatReading, parseSignalKTimestamp } from '../../webapp/instruments.mjs'
import { trackingPresentation } from '../../webapp/tracking-controls.mjs'
import { trackCoordinates, appendTrackPoint, bootstrapTrack, needsRebootstrap } from '../../webapp/track.mjs'

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
  assert.ok(requests.every(([url, options]) => url.endsWith('/navigation/course') && options?.operation === 'read-active-course'))
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

test('onboard race plan presentation switches authority and warns without a pack', async () => {
  const { racePlanPresentation } = await import('../../webapp/race-plan.mjs')
  const missing = racePlanPresentation({ uploadMode: 'local_only', calculationAuthority: 'onboard', pack: { available: false } })
  assert.equal(missing.authority, 'Onboard')
  assert.match(missing.warning, /Race Pack/)
  assert.equal(missing.currentLeg, null)
  assert.match(missing.packStatus, /No Race Pack/)

  const snapshot = { generatedAt: Date.now(), plan: { legs: [
    { sequence: 1, to: { name: 'Eastern mark' }, conditions: { source: 'observed', twsKnots: 12, twdDeg: 45, sampleTime: null }, pointOfSail: 'close reach', plan: { summary: 'Full main + No. 3 jib', confidence: 'high' } },
    { sequence: 2, to: { name: 'Race finish' }, conditions: { source: 'forecast', twsKnots: 14, twdDeg: 60, sampleTime: '2026-09-17T03:00:00Z' }, pointOfSail: 'beam reach', plan: { summary: 'Full main + A2 kite', confidence: 'medium' } }
  ] } }
  const onboard = racePlanPresentation({ uploadMode: 'local_only', calculationAuthority: 'onboard', pack: { available: true, revision: 4, applicable: true, ruleSetVersion: 'race_plan_dynamic_v1' }, latestSnapshot: snapshot })
  assert.equal(onboard.authority, 'Onboard')
  assert.equal(onboard.currentLeg.name, 'Eastern mark')
  assert.equal(onboard.currentLeg.usedObserved, true)
  assert.equal(onboard.currentLeg.summary, 'Full main + No. 3 jib')
  assert.equal(onboard.remainingLegs.length, 2)
  assert.equal(onboard.warning, null)
  assert.equal(onboard.historyOnly, false)

  const automatic = racePlanPresentation({ uploadMode: 'automatic', calculationAuthority: 'cloud', pack: { available: true, revision: 4 }, latestSnapshot: snapshot })
  assert.equal(automatic.authority, 'Wake Logger')
  assert.equal(automatic.historyOnly, true)
  assert.equal(automatic.stale, true)
})

test('onboard race plan surfaces observation fallback and forecast expiry warnings', async () => {
  const { racePlanPresentation } = await import('../../webapp/race-plan.mjs')
  const legs = [
    { sequence: 1, to: { name: 'Mark' }, conditions: { source: 'forecast', twsKnots: 14, twdDeg: 45, forecastCoverage: 'within' }, plan: { summary: 'Full main', confidence: 'medium' } },
    { sequence: 2, to: { name: 'Finish' }, conditions: { source: 'forecast', twsKnots: null, twdDeg: null, forecastCoverage: 'out_of_range' }, plan: null }
  ]
  const view = racePlanPresentation({
    uploadMode: 'local_only', calculationAuthority: 'onboard', observationsReady: false,
    pack: { available: true, revision: 4, applicable: true, ruleSetVersion: 'race_plan_dynamic_v1' },
    latestSnapshot: { generatedAt: Date.now(), forecastCoverage: 'partial', warning: 'Fresh onboard observations not yet available', plan: { legs } }
  })
  assert.equal(view.warning, 'Fresh onboard observations not yet available')
  assert.equal(view.stale, true)
  assert.equal(view.forecastCoverage, 'partial')
  assert.equal(view.observationsReady, false)
  assert.equal(view.remainingLegs[1].outOfRange, true)
  assert.equal(view.remainingLegs[1].summary, null)
})

test('Signal K failures preserve bounded, credentialed-safe diagnostics', () => {
  assert.match(boundedDetail('Bearer abc.def.ghi token=secret-value\nsecond line'), /^\[redacted\] \[redacted\] second line$/)
  assert.equal(boundedDetail('x'.repeat(5000)).length, 2000)
  const parsed = parseSignalKError(409, JSON.stringify({ errorCode: 'course_conflict', message: 'Another application owns the active route' }))
  assert.equal(parsed.errorCode, 'course_conflict')
  assert.equal(parsed.detail, 'Another application owns the active route')
  const codeOnly = parseSignalKError(409, JSON.stringify({ errorCode: 'native_route_conflict' }))
  assert.equal(codeOnly.errorCode, 'native_route_conflict')
  const error = new SignalKRequestError({ operation: 'next-point', method: 'PUT', path: '/signalk/v2/api/vessels/self/navigation/course/activeRoute/nextPoint', status: 409, errorCode: 'native_route_conflict', detail: 'Bearer zzz token=abc rejected' })
  assert.equal(error.status, 409)
  assert.equal(error.operation, 'next-point')
  const diagnostic = error.toDiagnostic()
  assert.deepEqual(Object.keys(diagnostic).sort(), ['detail', 'errorCode', 'method', 'operation', 'path', 'status'])
  assert.ok(!JSON.stringify(diagnostic).includes('zzz'))
  assert.ok(!JSON.stringify(diagnostic).includes('abc rejected'))
  assert.match(new SignalKRequestError({ status: 403, operation: 'set-point' }).message, /Sign in to Signal K/)
  assert.match(new SignalKRequestError({ status: 500, operation: 'set-point', detail: 'boom' }).message, /Signal K request failed \(500\): boom/)
})

test('navigation failures are human-readable and name the target mark', () => {
  const advance = new SignalKRequestError({ operation: 'next-point', method: 'PUT', path: '/x', status: 409, detail: 'active route update rejected' })
  assert.equal(describeNavigationFailure(advance, { markName: 'Eastern mark' }), 'Could not advance to the next course point to Eastern mark — Signal K rejected the active route update: active route update rejected.')
  assert.match(describeNavigationFailure(new SignalKRequestError({ operation: 'set-point', status: 409 }), { markNumber: 3 }), /Could not set the active course point to Mark 3/)
  assert.match(describeNavigationFailure(new SignalKRequestError({ operation: 'activate-course', status: 409, detail: 'conflict' })), /Could not activate the Wake Logger course — Signal K rejected the course activation: conflict\./)
  assert.match(describeNavigationFailure(new SignalKRequestError({ status: 401, operation: 'next-point' })), /Sign in to Signal K/)
})

test('offline readiness presentation drives the pre-switch warning', () => {
  const notReady = offlineReadinessPresentation({ ready: false, missing: ['the expected Wake Logger route is not active', 'the stored Race Pack does not match the selected course'], detail: 'Missing: ...' })
  assert.equal(notReady.ready, false)
  assert.equal(notReady.label, 'Offline race not ready')
  const warning = localOnlyWarning({ ready: false, missing: notReady.missing })
  assert.match(warning, /Offline race not ready/)
  assert.match(warning, /Race Pack does not match/)
  assert.equal(localOnlyWarning({ ready: true, missing: [] }), null)
  assert.equal(offlineReadinessPresentation(null).known, false)
})

test('instruments present RFC 3339 local measurements with references and units', () => {
  const now = Date.parse('2026-09-17T02:05:00Z')
  const ts = (offsetMs = 0) => new Date(now - offsetMs).toISOString()
  const view = instrumentReadings({
    now,
    navigation: {
      position: { value: { latitude: -27.4, longitude: 153.17 }, timestamp: ts(3000) },
      speedOverGround: { value: 3.0, timestamp: ts(1000) },
      courseOverGroundTrue: { value: Math.PI / 2, timestamp: ts(1000) },
      headingTrue: { value: Math.PI, timestamp: ts(1000) },
      speedThroughWater: { value: 2.8, timestamp: ts(1000) }
    },
    environment: {
      depth: { belowTransducer: { value: 12.5, timestamp: ts(1000) } },
      wind: { speedApparent: { value: 8, timestamp: ts(1000) }, angleApparent: { value: 0.5, timestamp: ts(1000) } }
    }
  })
  const byId = Object.fromEntries(view.readings.map((reading) => [reading.id, reading]))
  assert.equal(byId.position.freshness, 'fresh')
  assert.match(byId.position.formatted, /27\.4000° S, 153\.1700° E/)
  assert.equal(byId.sog.value.toFixed(1), '5.8')
  assert.equal(byId.cog.value.toFixed(0), '90')
  assert.equal(byId.heading.reference, 'true')
  assert.equal(byId.depth.reference, 'below transducer')
  assert.equal(byId.awa.reference, 'apparent')
  assert.equal(byId.tws.source, 'derived')
  assert.equal(byId.twd.source, 'derived')
  assert.equal(byId['vmg-wind-ground'].reference, 'wind · ground')
  assert.equal(formatReading(byId.sog), '5.8 kn')
})

test('freshness is per measurement and independent sensors survive stale GPS', () => {
  const now = Date.parse('2026-09-17T02:05:00Z')
  const ts = (offsetMs = 0) => new Date(now - offsetMs).toISOString()
  const view = instrumentReadings({
    now,
    staleSeconds: 30,
    navigation: { position: { value: { latitude: -27, longitude: 153 }, timestamp: ts(400_000) } },
    environment: { wind: { speedTrue: { value: 7, timestamp: ts(1000) }, directionTrue: { value: 1, timestamp: ts(1000) } }, depth: { belowKeel: { value: 9, timestamp: ts(1000) } } }
  })
  const byId = Object.fromEntries(view.readings.map((reading) => [reading.id, reading]))
  assert.equal(byId.position.freshness, 'stale')
  assert.equal(byId.position.available, false)
  assert.equal(byId.position.ageSeconds, 400)
  // Loss of GPS must not blank valid wind or depth.
  assert.equal(byId.tws.available, true)
  assert.equal(byId.twd.available, true)
  assert.equal(byId.depth.available, true)
  assert.equal(byId.depth.reference, 'below keel')
  // Only the stale measurement is marked stale.
  assert.equal(view.readings.filter((reading) => reading.freshness === 'stale').length, 1)
})

test('instruments never fabricate wind; missing, invalid and future timestamps are unknown', () => {
  const now = Date.parse('2026-09-17T02:05:00Z')
  const ts = (offsetMs = 0) => new Date(now - offsetMs).toISOString()
  const bare = instrumentReadings({ now, environment: { depth: { belowSurface: { value: 4, timestamp: ts() } } } })
  const b = Object.fromEntries(bare.readings.map((reading) => [reading.id, reading]))
  assert.equal(b.tws.value, null)
  assert.equal(b.tws.freshness, 'missing')
  assert.equal(b.sog.value, null)
  assert.match(formatReading(b.tws), /Unavailable/)

  // Apparent wind alone, with no boat reference, cannot be turned into true wind.
  const apparentOnly = instrumentReadings({ now, environment: { wind: { speedApparent: { value: 10, timestamp: ts() }, angleApparent: { value: 0.5, timestamp: ts() } } } })
  const ao = Object.fromEntries(apparentOnly.readings.map((reading) => [reading.id, reading]))
  assert.equal(ao.aws.available, true)
  assert.equal(ao.tws.value, null)

  assert.equal(instrumentReadings({ now, navigation: { speedOverGround: { value: 3 } } }).readings.find((r) => r.id === 'sog').freshness, 'unknown')
  assert.equal(instrumentReadings({ now, navigation: { speedOverGround: { value: 3, timestamp: 'not-a-time' } } }).readings.find((r) => r.id === 'sog').freshness, 'unknown')
  assert.equal(instrumentReadings({ now, navigation: { speedOverGround: { value: 3, timestamp: new Date(now + 60_000).toISOString() } } }).readings.find((r) => r.id === 'sog').freshness, 'unknown')
})

test('derived wind requires fresh reference-compatible inputs with bounded skew', () => {
  const now = Date.parse('2026-09-17T02:05:00Z')
  const ts = (offsetMs = 0) => new Date(now - offsetMs).toISOString()
  const source = (view, id) => view.readings.find((reading) => reading.id === id)

  // Fresh AWS but stale AWA: not usable.
  const staleAwa = instrumentReadings({ now, navigation: { speedOverGround: { value: 3, timestamp: ts() }, courseOverGroundTrue: { value: 1, timestamp: ts() }, headingTrue: { value: 1, timestamp: ts() } }, environment: { wind: { speedApparent: { value: 9, timestamp: ts() }, angleApparent: { value: 0.5, timestamp: ts(120_000) } } } })
  assert.equal(source(staleAwa, 'tws').value, null)

  // Fresh apparent but stale motion/heading: not usable.
  const staleMotion = instrumentReadings({ now, navigation: { speedOverGround: { value: 3, timestamp: ts(120_000) }, courseOverGroundTrue: { value: 1, timestamp: ts(120_000) }, headingTrue: { value: 1, timestamp: ts(120_000) } }, environment: { wind: { speedApparent: { value: 9, timestamp: ts() }, angleApparent: { value: 0.5, timestamp: ts() } } } })
  assert.equal(source(staleMotion, 'tws').value, null)

  // Fresh inputs but time skew beyond the policy: not usable.
  const skewed = instrumentReadings({ now, skewSeconds: 5, navigation: { speedOverGround: { value: 3, timestamp: ts() }, courseOverGroundTrue: { value: 1, timestamp: ts() }, headingTrue: { value: 1, timestamp: ts(60_000) } }, environment: { wind: { speedApparent: { value: 9, timestamp: ts() }, angleApparent: { value: 0.5, timestamp: ts(60_000) } } } })
  assert.equal(source(skewed, 'tws').value, null)

  // A magnetic-only heading is never treated as true.
  const magnetic = instrumentReadings({ now, navigation: { speedOverGround: { value: 3, timestamp: ts() }, courseOverGroundTrue: { value: 1, timestamp: ts() }, headingMagnetic: { value: 1, timestamp: ts() } }, environment: { wind: { speedApparent: { value: 9, timestamp: ts() }, angleApparent: { value: 0.5, timestamp: ts() } } } })
  assert.equal(source(magnetic, 'heading').reference, 'magnetic')
  assert.equal(source(magnetic, 'tws').source, 'direct')
  assert.equal(source(magnetic, 'tws').value, null)
})

test('every derivation input participates in freshness and skew', () => {
  const now = Date.parse('2026-09-17T02:05:00Z')
  const ts = (offsetMs = 0) => new Date(now - offsetMs).toISOString()
  const source = (view, id) => view.readings.find((reading) => reading.id === id)
  const ground = (overrides = {}) => {
    const nav = {
      speedOverGround: { value: 3, timestamp: ts() }, courseOverGroundTrue: { value: 1, timestamp: ts() },
      headingTrue: { value: 1, timestamp: ts() }
    }
    const wind = { speedApparent: { value: 9, timestamp: ts() }, angleApparent: { value: 0.5, timestamp: ts() } }
    for (const [path, value] of Object.entries(overrides.nav ?? {})) nav[path] = value
    for (const [path, value] of Object.entries(overrides.wind ?? {})) wind[path] = value
    return instrumentReadings({ now, skewSeconds: overrides.skewSeconds ?? 10, navigation: nav, environment: { wind } })
  }

  // SOG 25 s old while AWS/AWA/heading/COG are current. It is within the 30 s
  // freshness limit, so only the 10 s skew policy blocks the derivation; a wider
  // skew policy accepts it, proving the distinction.
  const oldSog = { speedOverGround: { value: 3, timestamp: ts(25_000) } }
  assert.equal(source(ground({ nav: oldSog }), 'tws').value, null)
  assert.notEqual(source(ground({ nav: oldSog, skewSeconds: 30 }), 'tws').value, null)

  // Water-referenced STW 25 s old with otherwise current inputs.
  const water = (stwTimestamp) => instrumentReadings({ now, skewSeconds: 10, navigation: { headingTrue: { value: 1, timestamp: ts() }, speedThroughWater: { value: 2.5, timestamp: stwTimestamp } }, environment: { wind: { speedApparent: { value: 9, timestamp: ts() }, angleApparent: { value: 0.5, timestamp: ts() } } } })
  assert.equal(source(water(ts(25_000)), 'tws').value, null)
  assert.notEqual(source(water(ts()), 'tws').value, null)

  // Heading 25 s old when converting AWA to an absolute direction.
  const oldHeading = { headingTrue: { value: 1, timestamp: ts(25_000) } }
  assert.equal(source(ground({ nav: oldHeading }), 'tws').value, null)

  // Each required input independently stale (older than the freshness limit).
  for (const overrides of [
    { nav: { speedOverGround: { value: 3, timestamp: ts(40_000) } } },
    { nav: { courseOverGroundTrue: { value: 1, timestamp: ts(40_000) } } },
    { nav: { headingTrue: { value: 1, timestamp: ts(40_000) } } },
    { wind: { speedApparent: { value: 9, timestamp: ts(40_000) } } },
    { wind: { angleApparent: { value: 0.5, timestamp: ts(40_000) } } }
  ]) assert.equal(source(ground(overrides), 'tws').value, null)

  // An unknown or future timestamp on any required input invalidates it.
  assert.equal(source(ground({ nav: { speedOverGround: { value: 3 } } }), 'tws').value, null)
  assert.equal(source(ground({ wind: { angleApparent: { value: 0.5, timestamp: new Date(now + 60_000).toISOString() } } }), 'tws').value, null)

  // VMG obeys the same discipline: a stale SOG blocks ground VMG.
  const vmgInputs = { speedOverGround: { value: 3, timestamp: ts(25_000) }, courseOverGroundTrue: { value: 1, timestamp: ts() }, headingTrue: { value: 1, timestamp: ts() } }
  const vmgView = instrumentReadings({ now, skewSeconds: 10, navigation: vmgInputs, environment: { wind: { speedTrue: { value: 8, timestamp: ts() }, directionTrue: { value: 0.5, timestamp: ts() } } } })
  assert.equal(source(vmgView, 'vmg-wind-ground'), undefined)
})

test('true wind angle references and wind-relative VMG bases are explicit', () => {
  const now = Date.parse('2026-09-17T02:05:00Z')
  const ts = (offsetMs = 0) => new Date(now - offsetMs).toISOString()
  const view = instrumentReadings({
    now,
    navigation: { speedOverGround: { value: 3, timestamp: ts() }, courseOverGroundTrue: { value: Math.PI / 2, timestamp: ts() }, headingTrue: { value: Math.PI, timestamp: ts() }, speedThroughWater: { value: 2.5, timestamp: ts() } },
    environment: { wind: { speedTrue: { value: 7, timestamp: ts() }, directionTrue: { value: 0, timestamp: ts() }, angleTrueGround: { value: 1, timestamp: ts() }, angleTrueWater: { value: 1.2, timestamp: ts() } } }
  })
  const byId = Object.fromEntries(view.readings.map((reading) => [reading.id, reading]))
  assert.equal(byId['twa-ground'].reference, 'ground')
  assert.equal(byId['twa-water'].reference, 'water')
  assert.equal(byId['vmg-wind-ground'].basis, 'ground')
  assert.equal(byId['vmg-wind-water'].basis, 'water')
})

test('durable track helpers order, never drop the departure, and request re-bootstrap', () => {
  const points = trackCoordinates([{ sequence: 3, latitude: -27.2, longitude: 153.2 }, { sequence: 1, latitude: -27.0, longitude: 153.0 }, { sequence: 2, latitude: NaN, longitude: 1 }])
  assert.deepEqual(points, [[-27, 153], [-27.2, 153.2]])
  let track = appendTrackPoint([[1, 2]], [1, 2])
  assert.deepEqual(track, [[1, 2]])
  track = appendTrackPoint(track, [3, 4])
  assert.deepEqual(track, [[1, 2], [3, 4]])
  // At the cap the oldest point is preserved: append refuses and the caller re-bootstraps.
  const full = [[1, 2], [3, 4], [5, 6]]
  assert.deepEqual(appendTrackPoint(full, [7, 8], 3), full)
  // A server bootstrap keeps the departure (no slice(-maxPoints)).
  assert.deepEqual(bootstrapTrack({ points: [{ sequence: 2, latitude: 2, longitude: 2 }, { sequence: 1, latitude: 1, longitude: 1 }] }), [[1, 1], [2, 2]])
  assert.deepEqual(bootstrapTrack(null), [])
  assert.equal(needsRebootstrap({ trackLength: 0, fixesSinceBootstrap: 0 }), true)
  assert.equal(needsRebootstrap({ trackLength: 100, fixesSinceBootstrap: 10 }), false)
  assert.equal(needsRebootstrap({ trackLength: 100, fixesSinceBootstrap: 250 }), true)
  assert.equal(needsRebootstrap({ trackLength: 100, fixesSinceBootstrap: 1, recordingChanged: true }), true)
  assert.equal(needsRebootstrap({ trackLength: 100, fixesSinceBootstrap: 1, resumed: true }), true)
  assert.equal(needsRebootstrap({ trackLength: 100, fixesSinceBootstrap: 1, gapDetected: true }), true)
})

test('lifetime retention loss is never presented as current-trip loss', () => {
  const view = trackingPresentation({ paired: true, recording: true, uploadMode: 'automatic', connectionState: 'online', lifetimeDroppedCount: 9830, cohortDroppedSamples: 0, queue: { messageCount: 4 } })
  assert.equal(view.loss, null)
  assert.equal(view.lifetimeDroppedCount, 9830)
  assert.doesNotMatch(view.description, /9830/)
  const pressure = trackingPresentation({ paired: true, recording: true, uploadMode: 'automatic', lifetimeDroppedCount: 9830, cohortDroppedSamples: 12, cohortProgressKnown: false, queue: { messageCount: 4 } })
  assert.match(pressure.description, /12 samples in this upload were discarded/)
  assert.match(pressure.description, /not complete/)
  assert.equal(pressure.loss.progressKnown, false)
})

test('an available but inapplicable pack is stored, never shown as current', async () => {
  const { racePlanPresentation } = await import('../../webapp/race-plan.mjs')
  const snapshot = { generatedAt: Date.now(), plan: { legs: [
    { sequence: 1, to: { name: 'Old mark' }, conditions: { source: 'observed', twsKnots: 12, twdDeg: 45 }, plan: { summary: 'Old recommendation' } }
  ] } }
  const view = racePlanPresentation({ uploadMode: 'local_only', calculationAuthority: 'onboard', pack: { available: true, revision: 4, applicable: false, ruleSetVersion: 'race_plan_dynamic_v1' }, latestSnapshot: snapshot })
  assert.equal(view.packAvailable, true)
  assert.equal(view.packApplicable, false)
  assert.match(view.packStatus, /stored/)
  assert.match(view.packStatus, /does not match the selected course/)
  assert.equal(view.currentLeg, null)
  assert.deepEqual(view.remainingLegs, [])
  assert.match(view.warning, /does not match the selected Wake Logger course/)
})

test('request deadlines stay active through the response body and recover', async () => {
  const { SignalKClient } = await import('../../webapp/api-client.mjs')
  const originalFetch = globalThis.fetch
  const hadSession = 'sessionStorage' in globalThis
  const originalSession = globalThis.sessionStorage
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  try {
    // No headers: fetch never settles.
    globalThis.fetch = () => new Promise(() => {})
    const client = new SignalKClient()
    await assert.rejects(client.request('/x', { operation: 'read-navigation', timeoutMs: 40 }), (error) => error.status === 504 && error.errorCode === 'timeout')

    // Headers received but the body stalls.
    globalThis.fetch = () => Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await assert.rejects(client.request('/x', { timeoutMs: 40 }), (error) => error.status === 504)

    // Partial JSON followed by a stall.
    globalThis.fetch = () => Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"a":')) } }), { status: 200 }))
    await assert.rejects(client.request('/x', { timeoutMs: 40 }), (error) => error.status === 504)

    // A stalled error body is bounded and interrupted by the deadline.
    globalThis.fetch = () => Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 500 }))
    await assert.rejects(client.request('/x', { timeoutMs: 40 }), (error) => error.status === 504)

    // Malformed JSON that completes rejects promptly (a parse error, not a hang).
    globalThis.fetch = () => Promise.resolve(new Response('{not json', { status: 200 }))
    await assert.rejects(client.request('/x', { timeoutMs: 1000 }), (error) => error?.errorCode !== 'timeout')

    // The next polling cycle recovers normally.
    globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
    assert.deepEqual(await client.request('/x', { timeoutMs: 1000 }), { ok: true })
  } finally {
    globalThis.fetch = originalFetch
    if (hadSession) globalThis.sessionStorage = originalSession
    else delete globalThis.sessionStorage
  }
})
