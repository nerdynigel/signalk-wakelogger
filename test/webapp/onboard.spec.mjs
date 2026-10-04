import { test, expect } from '@playwright/test'

const ownedRouteId = '8be48170-2453-4107-a1aa-c2c8bea39901'
const ownedHref = `/resources/routes/${ownedRouteId}`
const secret = 'must-never-render-device-credential'
const points = [
  { id: 'start', name: 'Race start', latitude: -27.40, longitude: 153.17 },
  { id: 'mark-1', name: 'Eastern mark', latitude: -27.39, longitude: 153.19 },
  { id: 'finish', name: 'Race finish', latitude: -27.38, longitude: 153.17 },
]
const desired = { v: 1, revision: 7, courseId: 'race-42', racePlanId: 42, name: 'Saturday bay race', updatedAt: '2026-09-13T01:00:00Z', action: 'activate', start: points[0], marks: [points[1]], finish: points[2], activeWaypointIndex: 1 }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

async function mockBoat(page, { charts = {}, conflict = false, missingDirection = false, progression = null, racePlan = null, course = true, courseError = 0, environment = {}, navigationOverride = null, track = [], trackId = 'rec-1', courseState = null, readiness = null } = {}) {
  const writes = []
  let uploadMode = 'local_only'
  let progressionState = progression
  let controlGeneration = 0
  let controlState = { clientId: null, active: false, expiresAt: null, generation: null }
  const external = []
  // Test control for the recording/history identity ordering: a one-shot delay
  // on the next /track response and the /tracking-reported recording identity.
  const control = {
    trackDelayOnce: 0,
    trackingSessionId: null,
    trackFailuresRemaining: 0,
    trackRequests: [],
    emptyRecordingId: null,
  }
  let navigation = {
    startTime: '2026-09-13T01:00:00Z', arrivalCircle: 50,
    activeRoute: { href: conflict ? '/resources/routes/another-route' : ownedHref, pointIndex: 1, pointTotal: 3, reverse: false, name: conflict ? 'Existing native route' : desired.name },
    previousPoint: { type: 'RoutePoint', position: { latitude: points[0].latitude, longitude: points[0].longitude }, name: points[0].name },
    nextPoint: { type: 'RoutePoint', position: { latitude: points[1].latitude, longitude: points[1].longitude }, name: points[1].name },
  }
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== 'http://127.0.0.1:4178') {
      external.push(request.url())
      return route.abort()
    }
    const json = (body) => route.fulfill({ json: body })
    const pathname = url.pathname
    if (pathname === '/plugins/signalk-wakelogger/tracking') {
      if (request.method() === 'POST') { uploadMode = request.postDataJSON().uploadMode; writes.push({ path: pathname, method: 'POST', body: { uploadMode } }) }
      return json({
        uploadMode, paired: true, recording: true,
        trackingSessionId: control.trackingSessionId,
        connectionState: uploadMode === 'automatic' ? 'online' : 'recording_locally',
        queue: { messageCount: 123, currentSequence: 200, acknowledgedSequence: 77 }
      })
    }
    if (pathname === '/plugins/signalk-wakelogger/course') {
      if (courseError) return route.fulfill({ status: courseError, json: { error: 'course_unavailable', detail: 'Signal K course provider rejected the request' } })
      if (courseState) return json(typeof courseState === 'function' ? courseState() : courseState)
      if (!course) return json({ desired: null, cachedCourse: null, acknowledgement: null, routePoints: [], native: { available: false, course: null, ownedRouteId: null, activeMatchesDesired: false, conflict: false } })
      return json({ desired, cachedCourse: desired, acknowledgement: { v: 1, revision: 7, status: 'applied' }, routePoints: points,
        native: { available: true, course: navigation, ownedRouteId, activeMatchesDesired: navigation.activeRoute.href === ownedHref, conflict: navigation.activeRoute.href !== ownedHref },
        credentials: { password: secret },
      })
    }
    if (pathname === '/plugins/signalk-wakelogger/offline-readiness') return json(readiness || { ready: false, label: 'Offline race not ready', missing: ['no Wake Logger course is selected'], detail: 'Missing: no Wake Logger course is selected.' })
    if (pathname === '/plugins/signalk-wakelogger/track') {
      const rows = typeof track === 'function' ? track() : track
      const id = typeof trackId === 'function' ? trackId() : trackId
      control.trackRequests.push(id)
      if (control.trackFailuresRemaining > 0) {
        control.trackFailuresRemaining -= 1
        return route.fulfill({ status: 503, json: { error: 'track_archive_unavailable' } })
      }
      if (control.trackDelayOnce > 0) {
        const delay = control.trackDelayOnce
        control.trackDelayOnce = 0
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      const sequences = rows.map((point) => point.sequence).filter(Number.isFinite)
      return json({
        storageBackend: 'file',
        points: rows,
        summary: { fromSequence: sequences.length ? Math.min(...sequences) : null, throughSequence: sequences.length ? Math.max(...sequences) : null, totalSamples: rows.length, decimated: false },
        recording: rows.length
          ? { id, state: 'recording', firstSequence: sequences.length ? Math.min(...sequences) : 1 }
          : control.emptyRecordingId
            ? { id: control.emptyRecordingId, state: 'recording', firstSequence: 1 }
            : null,
        trackingSessionId: rows.length ? id : control.emptyRecordingId || null
      })
    }
    if (pathname === '/plugins/signalk-wakelogger/progression') return json({ ...(progressionState ?? {}), control: controlState })
    if (pathname === '/plugins/signalk-wakelogger/progression/control') {
      const body = request.postDataJSON()
      if (body.release) controlState = { clientId: null, active: false, expiresAt: null, generation: null }
      else if (controlState.active && controlState.clientId !== body.clientId) return route.fulfill({ status: 409, json: { error: 'navigation_control_held', control: controlState } })
      else {
        if (!controlState.active || controlState.clientId !== body.clientId) controlGeneration += 1
        controlState = { clientId: body.clientId, active: true, expiresAt: Date.now() + 30000, generation: controlGeneration }
      }
      return json({ control: controlState })
    }
    if (pathname === '/plugins/signalk-wakelogger/progression/apply') {
      const body = request.postDataJSON()
      if (!controlState.active || controlState.clientId !== body.clientId || controlState.generation !== body.generation) {
        return route.fulfill({ status: 409, json: { error: 'navigation_control_not_held', control: controlState } })
      }
      if (progressionState?.pending?.pointIndex !== body.detectionPointIndex) return route.fulfill({ status: 409, json: { error: 'no_pending_detection' } })
      const target = body.detectionPointIndex + 1
      if (navigation.activeRoute.pointIndex > target) return json({ status: 'superseded', targetPointIndex: target })
      if (navigation.activeRoute.pointIndex === target) return json({ status: 'already_applied', targetPointIndex: target, generation: controlState.generation })
      if (navigation.activeRoute.pointIndex !== body.detectionPointIndex) return route.fulfill({ status: 409, json: { error: 'stale_point' } })
      return json({ status: 'apply', targetPointIndex: target, generation: controlState.generation })
    }
    if (pathname === '/plugins/signalk-wakelogger/progression/apply/confirm') {
      const body = request.postDataJSON()
      if (!controlState.active || controlState.clientId !== body.clientId || controlState.generation !== body.generation) {
        return route.fulfill({ status: 409, json: { error: 'navigation_control_not_held', control: controlState } })
      }
      const native = navigation.activeRoute.pointIndex
      if (native > body.targetPointIndex) return json({ status: 'superseded', targetPointIndex: body.targetPointIndex, nativePointIndex: native })
      if (native === body.targetPointIndex) return json({ status: 'confirmed', targetPointIndex: body.targetPointIndex, nativePointIndex: native })
      return json({ status: 'pending', targetPointIndex: body.targetPointIndex, nativePointIndex: native })
    }
    if (pathname === '/plugins/signalk-wakelogger/race-plan') return json(racePlan)
    if (pathname === '/plugins/signalk-wakelogger/progression/resolve') {
      const body = request.postDataJSON()
      writes.push({ path: pathname, method: request.method(), body })
      if (progressionState?.pending?.pointIndex === body.pointIndex) progressionState = { ...progressionState, pending: null }
      return json(progressionState)
    }
    if (pathname === '/plugins/signalk-wakelogger/course/activate') {
      writes.push({ path: pathname, method: request.method(), body: request.postDataJSON() })
      navigation = { ...navigation, activeRoute: { ...navigation.activeRoute, href: ownedHref, name: desired.name } }
      return json({ status: 'ok' })
    }
    if (pathname === `/signalk/v2/api/resources/routes/${ownedRouteId}`) return json({ name: desired.name, feature: { type: 'Feature', geometry: { type: 'LineString', coordinates: points.map((point) => [point.longitude, point.latitude]) }, properties: { coordinatesMeta: points.map((point) => ({ name: point.name })) } } })
    if (pathname === '/signalk/v2/api/resources/charts') return json(charts)
    if (pathname.startsWith('/signalk/chart-tiles/')) return route.fulfill({ contentType: 'image/png', body: png })
    if (pathname === '/signalk/v2/api/vessels/self/navigation/course/calcValues') return json({ distance: 1250, bearingTrue: 1.1, crossTrackError: 4, velocityMadeGood: 3.2, timeToGo: 390, estimatedTimeOfArrival: '2026-09-13T01:06:30Z' })
    if (pathname === '/signalk/v2/api/vessels/self/navigation/course') return json(navigation)
    if (pathname.startsWith('/signalk/v2/api/vessels/self/navigation/course/activeRoute/')) {
      const body = request.postDataJSON()
      writes.push({ path: pathname, method: request.method(), body })
      const index = pathname.endsWith('/nextPoint') ? navigation.activeRoute.pointIndex + (body.value ?? 1) : body.value
      navigation = { ...navigation, activeRoute: { ...navigation.activeRoute, pointIndex: index } }
      return json({ state: 'COMPLETED', statusCode: 200 })
    }
    if (pathname === '/signalk/v1/api/vessels/self/navigation') {
      if (navigationOverride) return json(typeof navigationOverride === 'function' ? navigationOverride() : navigationOverride)
      return json({ position: { value: { latitude: -27.395, longitude: 153.18 }, timestamp: new Date().toISOString() }, speedOverGround: { value: 3.2 }, ...(missingDirection ? {} : { courseOverGroundTrue: { value: 1.1 } }) })
    }
    if (pathname === '/signalk/v1/api/vessels/self/environment') return json(typeof environment === 'function' ? environment() : environment)
    if (pathname === '/signalk/v1/api/vessels/self/navigation/position') return json({ value: { latitude: -27.395, longitude: 153.18 }, timestamp: new Date().toISOString() })
    if (pathname === '/plugins/signalk-wakelogger/status') return json({ connectionState: 'recording_locally', uploadMode: 'local_only', queueMessageCount: 123, credentials: { password: secret } })
    return route.continue()
  })
  return { writes, external, control }
}

// Selectors are kept in one place to describe the onboard controls.
const ui = {
  map: '#map',
  activate: '#activate-course',
  next: '#advance-point',
  index: '#point-index',
}

test('course and boat remain visible without chart sources or internet', async ({ page }) => {
  const { external, writes } = await mockBoat(page)
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator(ui.map)).toBeVisible()
  await expect(page.getByText(desired.name, { exact: true }).first()).toBeVisible()
  await expect(page.locator('.leaflet-overlay-pane path[stroke="#006a85"]').first()).toBeVisible()
  await expect(page.locator('body')).not.toContainText(secret)
  const saved = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(saved).not.toContain(secret)
  expect(external).toEqual([])
  expect(writes).toEqual([])
})

test('uses discovered local chart tiles without remote assets', async ({ page }, testInfo) => {
  const charts = { bay: { identifier: 'local-bay-chart', name: 'Local bay chart', type: 'tilelayer', format: 'png', url: '/signalk/chart-tiles/local-bay-chart/{z}/{x}/{y}', minzoom: 1, maxzoom: 18, bounds: [153, -28, 154, -27], proxy: false } }
  const { external } = await mockBoat(page, { charts })
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible()
  const tileUrls = await page.locator('.leaflet-tile-loaded').evaluateAll((tiles) => tiles.map((tile) => tile.src))
  expect(tileUrls.every((url) => url.includes('/signalk/chart-tiles/local-bay-chart/'))).toBe(true)
  expect(external).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('onboard-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(ui.map)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('onboard-mobile.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('advances native route and sets an explicit zero-based point', async ({ page }) => {
  const { writes } = await mockBoat(page)
  await page.goto('/signalk-wakelogger/')
  await page.locator('#course-tab').click()
  await expect(page.locator(ui.next)).toBeEnabled()
  await page.locator(ui.next).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ method: 'PUT', path: '/signalk/v2/api/vessels/self/navigation/course/activeRoute/nextPoint', body: { value: 1 } })
  await page.locator(ui.index).selectOption('0')
  await page.locator('#set-point').click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toMatchObject({ method: 'PUT', path: '/signalk/v2/api/vessels/self/navigation/course/activeRoute/pointIndex', body: { value: 0 } })
})

test('another native route stays active until explicit activation', async ({ page }) => {
  const { writes } = await mockBoat(page, { conflict: true })
  await page.goto('/signalk-wakelogger/')
  await page.locator('#course-tab').click()
  await expect(page.locator(ui.activate)).toBeVisible()
  expect(writes).toEqual([])
  await expect(page.locator(ui.next)).toBeDisabled()
  await page.locator(ui.activate).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ method: 'POST', path: '/plugins/signalk-wakelogger/course/activate' })
})

test('chart descriptions cannot inject markup into map attribution', async ({ page }) => {
  const charts = { local: { identifier: 'local-bay-chart', name: 'Bay', type: 'tilelayer', format: 'png', url: '/signalk/chart-tiles/local-bay-chart/{z}/{x}/{y}', minzoom: 1, maxzoom: 18, bounds: [153, -28, 154, -27], proxy: false, description: '<img src="/missing-attribution-image" onerror="document.body.dataset.chartInjection=1">' } }
  await mockBoat(page, { charts })
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible()
  await expect(page.locator('.leaflet-control-attribution img')).toHaveCount(0)
  expect(await page.locator('body').getAttribute('data-chart-injection')).toBeNull()
})


test('missing heading and COG show an un-oriented vessel position', async ({ page }) => {
  await mockBoat(page, { missingDirection: true })
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator('#centre-vessel')).toBeEnabled()
  await expect(page.locator('.vessel-icon')).toHaveCount(0)
  await expect(page.locator('.leaflet-marker-pane .mark').filter({ hasText: '●' })).toBeVisible()
})

test('live switch changes upload mode without stopping local recording', async ({ page }) => {
  const { writes } = await mockBoat(page)
  await page.goto('/signalk-wakelogger/')
  const toggle = page.getByRole('switch', { name: 'Live tracking' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('#tracking-mode')).toHaveText('Record locally')
  await expect(page.locator('#upload-queue')).toContainText('123 samples saved onboard')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('#tracking-mode')).toHaveText('Live + history')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(writes.map((entry) => entry.body)).toEqual([{ uploadMode: 'automatic' }, { uploadMode: 'local_only' }])
  await expect(page.locator('#tracking-description')).toContainText('Recording locally')
})

test('fullscreen works on desktop and mobile with tracking controls retained', async ({ page }, testInfo) => {
  await mockBoat(page)
  await page.goto('/signalk-wakelogger/')
  await page.getByRole('button', { name: 'Enter fullscreen' }).click()
  await expect(page.locator('#chartplotter')).toHaveClass(/is-fullscreen/)
  await expect(page.getByRole('switch', { name: 'Live tracking' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('onboard-desktop-fullscreen.png') })
  await page.getByRole('button', { name: 'Exit fullscreen' }).click()
  await expect(page.locator('#chartplotter')).not.toHaveClass(/is-fullscreen/)
  await page.setViewportSize({ width: 390, height: 844 })
  // Exercise the viewport fallback used by mobile browsers without the API.
  await page.evaluate(() => { document.getElementById('chartplotter').requestFullscreen = undefined })
  await expect(page.locator('#chartplotter')).toHaveAttribute('data-screen', 'mobile')
  await page.getByRole('button', { name: 'Enter fullscreen' }).click()
  await expect(page.locator('#chartplotter')).toHaveClass(/is-fullscreen/)
  const dimensions = await page.locator('#chartplotter').boundingBox()
  expect(dimensions.width).toBe(390)
  expect(dimensions.height).toBe(844)
  await expect(page.getByRole('switch', { name: 'Live tracking' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('onboard-mobile-fullscreen.png') })
  await page.keyboard.press('Escape')
  await expect(page.locator('#chartplotter')).not.toHaveClass(/is-fullscreen/)
})

test('failed mode save reads back the actual safely paused state', async ({ page }) => {
  await mockBoat(page)
  await page.route('**/plugins/signalk-wakelogger/tracking', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 503, json: { message: 'settings save failed' } })
    return route.fulfill({ json: { uploadMode: 'local_only', paired: true, recording: true, persistenceError: 'settings_save_failed', queue: { messageCount: 123 } } })
  })
  await page.goto('/signalk-wakelogger/')
  const toggle = page.getByRole('switch', { name: 'Live tracking' })
  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('#notice')).toContainText('could not be saved')
  await expect(page.locator('#tracking-description')).toContainText('Setting could not be saved')
})

test('automatic application is disabled; the controlling device must accept a rounding explicitly', async ({ page }) => {
  const { writes } = await mockBoat(page, {
    progression: { mode: 'auto', revision: 7, activeIndex: 1, pending: { type: 'rounding', pointIndex: 1, wrongSide: false, revision: 7, at: 0 }, lastDetection: null }
  })
  await page.goto('/signalk-wakelogger/')
  await expect(page.getByText(/Mark detection: Automatic/)).toBeVisible()
  // Neither a viewer nor the controlling device auto-advances.
  await page.waitForTimeout(1000)
  expect(writes).toEqual([])
  await page.locator('#navigation-control').click()
  await expect(page.locator('#navigation-control')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(1000)
  expect(writes).toEqual([])
  // A permit is issued, the native absolute point index is written, native state
  // confirms it, and only then is the detection accepted.
  await page.locator('#progression-accept').click()
  await expect.poll(() => writes.find((write) => write.path.endsWith('/pointIndex'))).toMatchObject({ method: 'PUT', body: { value: 2 } })
  await expect.poll(() => writes.find((write) => write.path.endsWith('/progression/resolve'))).toMatchObject({ body: { resolution: 'accepted', pointIndex: 1 } })
  expect(writes.find((write) => write.path.endsWith('/nextPoint'))).toBeUndefined()
})

test('holds a wrong-side detection for the crew instead of advancing', async ({ page }) => {
  const { writes } = await mockBoat(page, {
    progression: { mode: 'auto', revision: 7, activeIndex: 1, pending: { type: 'rounding', pointIndex: 1, wrongSide: true, revision: 7, at: 0 }, lastDetection: null }
  })
  await page.goto('/signalk-wakelogger/')
  await expect(page.getByText(/Mark detection: Automatic/)).toBeVisible()
  await page.waitForTimeout(500)
  expect(writes.find((write) => write.path.endsWith('/nextPoint'))).toBeUndefined()
})

const onboardRacePlan = {
  uploadMode: 'local_only', calculationAuthority: 'onboard',
  pack: { available: true, revision: 4, applicable: true, ruleSetVersion: 'race_plan_dynamic_v1' },
  latestSnapshot: {
    generatedAt: Date.now(),
    plan: { legs: [
      { sequence: 1, to: { name: 'Eastern mark' }, conditions: { source: 'observed', twsKnots: 12, twdDeg: 45 }, pointOfSail: 'close reach', plan: { summary: 'Full main + No. 3 jib', confidence: 'high' } },
      { sequence: 2, to: { name: 'Race finish' }, conditions: { source: 'forecast', twsKnots: 14, twdDeg: 60 }, pointOfSail: 'beam reach', plan: { summary: 'Full main + A2 kite', confidence: 'medium' } }
    ] }
  }
}

test('shows onboard Race Plan authority and recommendations in local-only mode', async ({ page }, testInfo) => {
  const { external } = await mockBoat(page, { racePlan: onboardRacePlan })
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator('#race-authority')).toHaveText(/Onboard/)
  await expect(page.locator('#race-authority')).toHaveAttribute('data-pack', 'ready')
  await expect(page.locator('[data-leg=current]')).toContainText('Eastern mark')
  await expect(page.locator('[data-leg=current]')).toContainText('Full main + No. 3 jib')
  await expect(page.locator('[data-leg=current]')).toContainText('observed')
  await expect(page.locator('[data-leg=remaining]')).toContainText('Race finish')
  await page.screenshot({ path: testInfo.outputPath('onboard-race-plan.png'), fullPage: true })
  expect(external).toEqual([])
})

test('labels Wake Logger as authority and marks onboard plans historical in automatic mode', async ({ page }) => {
  await mockBoat(page, { racePlan: { ...onboardRacePlan, uploadMode: 'automatic', calculationAuthority: 'cloud' } })
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator('#race-authority')).toHaveText(/Wake Logger/)
  await expect(page.locator('#race-plan-list')).toContainText('historical')
})

test('warns without a Race Pack but does not block local-only recording', async ({ page }) => {
  const { writes } = await mockBoat(page, { racePlan: { uploadMode: 'local_only', calculationAuthority: 'onboard', pack: { available: false } } })
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator('#race-plan-warning')).toContainText('Recording continues')
  await expect(page.getByRole('switch', { name: 'Live tracking' })).toBeEnabled()
  expect(writes).toEqual([])
})

const freshInstruments = () => {
  const now = Date.now()
  return {
    environment: {
      depth: { belowTransducer: { value: 12.5, timestamp: now } },
      wind: { speedTrue: { value: 7, timestamp: now }, directionTrue: { value: 0.8, timestamp: now }, speedApparent: { value: 9, timestamp: now }, angleApparent: { value: 0.5, timestamp: now } }
    },
    navigationOverride: {
      position: { value: { latitude: -27.4, longitude: 153.17 }, timestamp: now },
      speedOverGround: { value: 3, timestamp: now },
      courseOverGroundTrue: { value: 1.1, timestamp: now },
      headingTrue: { value: 1, timestamp: now },
      speedThroughWater: { value: 2.8, timestamp: now }
    }
  }
}

test('standalone instruments are the default with no course and need no Race Pack', async ({ page }, testInfo) => {
  const { writes, external } = await mockBoat(page, { course: false, ...freshInstruments() })
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator('#instruments-tab')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#instruments-panel')).toBeVisible()
  await expect(page.locator('#instruments-grid')).toContainText('Speed over ground')
  await expect(page.locator('#instruments-grid')).toContainText('True wind speed')
  await expect(page.locator('#instruments-grid')).toContainText('Depth')
  await expect(page.locator('#signal-k-state')).toContainText('Signal K connected')
  // Viewing instruments must not activate a course, advance a mark or change upload mode.
  expect(writes).toEqual([])
  expect(external).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('onboard-instruments.png'), fullPage: true })
})

test('instruments keep updating when the course API fails', async ({ page }) => {
  await mockBoat(page, { courseError: 409, ...freshInstruments() })
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator('#instruments-panel')).toBeVisible()
  await expect(page.locator('#instruments-grid')).toContainText('Speed over ground')
  await expect(page.locator('#notice')).toContainText('409')
})

test('losing GPS does not blank independent wind and depth', async ({ page }) => {
  const now = Date.now()
  await mockBoat(page, {
    course: false,
    environment: { depth: { belowSurface: { value: 4, timestamp: now } }, wind: { speedTrue: { value: 8, timestamp: now }, directionTrue: { value: 0.5, timestamp: now } } },
    navigationOverride: { speedOverGround: { value: 3, timestamp: now } }
  })
  await page.goto('/signalk-wakelogger/')
  const grid = page.locator('#instruments-grid')
  await expect(grid).toContainText('True wind speed')
  await expect(grid.locator('.instrument[data-available=true]').filter({ hasText: 'Depth' })).toHaveCount(1)
  await expect(grid.locator('.instrument[data-available=true]').filter({ hasText: 'True wind speed' })).toHaveCount(1)
  await expect(grid.locator('.instrument[data-available=false]').filter({ hasText: 'Position' })).toHaveCount(1)
})

test('a stale measurement is marked without ageing the others', async ({ page }) => {
  const now = Date.now()
  await mockBoat(page, {
    course: false,
    environment: { depth: { belowSurface: { value: 4, timestamp: now } }, wind: { speedTrue: { value: 8, timestamp: now - 120_000 }, directionTrue: { value: 0.5, timestamp: now - 120_000 } } }
  })
  await page.goto('/signalk-wakelogger/')
  const grid = page.locator('#instruments-grid')
  await expect(grid.locator('.instrument[data-stale=true]').first()).toBeVisible()
  await expect(grid.locator('.instrument[data-available=true]').filter({ hasText: 'Depth' })).toHaveCount(1)
})

test('reload and a second client are read-only and resume instruments', async ({ browser }) => {
  const context = await browser.newContext()
  const first = await context.newPage()
  const second = await context.newPage()
  const writes = []
  for (const page of [first, second]) {
    await mockBoat(page, { course: false, ...freshInstruments() })
    await page.goto('/signalk-wakelogger/')
    await expect(page.locator('#instruments-panel')).toBeVisible()
  }
  await first.reload()
  await expect(first.locator('#instruments-panel')).toBeVisible()
  await expect(first.locator('#instruments-grid')).toContainText('Speed over ground')
  await expect(second.locator('#instruments-grid')).toContainText('Speed over ground')
  expect(writes).toEqual([])
  await context.close()
})

test('a hanging course request does not freeze the standalone instruments', async ({ page }) => {
  const { external } = await mockBoat(page, { course: false, ...freshInstruments() })
  // Register after mockBoat so this handler takes precedence (routes are LIFO)
  // and never resolves: the course poll must be bounded and must not block the
  // independent instrument loop.
  await page.route('**/plugins/signalk-wakelogger/course', () => new Promise(() => {}))
  await page.goto('/signalk-wakelogger/')
  await expect(page.locator('#instruments-panel')).toBeVisible()
  await expect(page.locator('#instruments-grid')).toContainText('Speed over ground')
  await page.waitForTimeout(6000)
  await expect(page.locator('#instruments-grid')).toContainText('Speed over ground')
  await expect(page.locator('#instruments-grid .instrument[data-available=true]').first()).toBeVisible()
  expect(external).toEqual([])
})

async function expectFittedToTrack(map) {
  // Leaflet padding/rounding nudges the centre slightly; assert the viewport is
  // centred on the whole track and zoomed in from the initial world view.
  await expect.poll(async () => {
    const [lat, lon] = ((await map.getAttribute('data-viewport-center')) || '').split(',').map(Number)
    return Number.isFinite(lat) && Math.abs(lat + 27.5) < 0.05 && Math.abs(lon - 153.5) < 0.05
  }).toBe(true)
  await expect.poll(async () => Number((await map.getAttribute('data-viewport-zoom')) || 0)).toBeGreaterThan(2)
}

test('a late-joining onboard browser fits the whole recorded track with no course', async ({ page }) => {
  const track = [
    { sequence: 1, capturedAt: 1_000, latitude: -27.0, longitude: 153.0 },
    { sequence: 2, capturedAt: 2_000, latitude: -27.5, longitude: 153.5 },
    { sequence: 3, capturedAt: 3_000, latitude: -28.0, longitude: 154.0 },
  ]
  const { external } = await mockBoat(page, { track, course: false })
  await page.goto('/signalk-wakelogger/')
  const map = page.locator('#map')
  // The full recorded extent comes from local history, not page-open time.
  await expect(map).toHaveAttribute('data-track-point-count', '3')
  await expect(map).toHaveAttribute('data-track-start-sequence', '1')
  await expect(map).toHaveAttribute('data-track-end-sequence', '3')
  await expect(map).toHaveAttribute('data-track-south', '-28')
  await expect(map).toHaveAttribute('data-track-north', '-27')
  // Auto-fit happens even with no course, so the departure is on screen.
  await expect(map).toHaveAttribute('data-viewport-mode', 'track')
  await expectFittedToTrack(map)
  // Reload re-derives the same full extent from the local archive.
  await page.reload()
  await expect(map).toHaveAttribute('data-track-point-count', '3')
  await expect(map).toHaveAttribute('data-track-start-sequence', '1')
  await expectFittedToTrack(map)
  // Fit track stays available and works with no course.
  await expect(page.locator('#fit-track')).toBeEnabled()
  await page.locator('#fit-track').click()
  await expectFittedToTrack(map)
  // No Wake Logger network traffic while local_only.
  expect(external).toEqual([])
})

test('an empty initial archive reconciles promptly when durable history appears', async ({ page }) => {
  let rows = []
  const { external } = await mockBoat(page, { track: () => rows, course: false })
  await page.goto('/signalk-wakelogger/')
  const map = page.locator('#map')
  await expect(map).toHaveAttribute('data-track-point-count', '0')
  rows = [
    { sequence: 1, capturedAt: 1_000, latitude: -27.0, longitude: 153.0 },
    { sequence: 2, capturedAt: 2_000, latitude: -27.5, longitude: 153.5 },
    { sequence: 3, capturedAt: 3_000, latitude: -28.0, longitude: 154.0 },
  ]
  // Poll interval is 3s; this reconciles well before the 250-fix tail threshold.
  await expect(map).toHaveAttribute('data-track-point-count', '3', { timeout: 12_000 })
  await expect(map).toHaveAttribute('data-track-start-sequence', '1')
  await expectFittedToTrack(map)
  expect(external).toEqual([])
})

test('fullscreen and resize preserve the track viewport intent', async ({ page }) => {
  const track = [
    { sequence: 1, capturedAt: 1_000, latitude: -27.0, longitude: 153.0 },
    { sequence: 2, capturedAt: 2_000, latitude: -27.5, longitude: 153.5 },
    { sequence: 3, capturedAt: 3_000, latitude: -28.0, longitude: 154.0 },
  ]
  await mockBoat(page, { track, course: false })
  await page.goto('/signalk-wakelogger/')
  const map = page.locator('#map')
  await expect(map).toHaveAttribute('data-track-point-count', '3')
  await expect(map).toHaveAttribute('data-viewport-mode', 'track')
  await page.locator('#fullscreen').click()
  await expect(map).toHaveAttribute('data-viewport-mode', 'track')
  await expect(map).toHaveAttribute('data-track-point-count', '3')
  await expectFittedToTrack(map)
})

test('switching recordings replaces the displayed track without mixing A and B', async ({ page }) => {
  let id = 'A'
  let rows = [
    { sequence: 1, capturedAt: 1_000, latitude: -27.0, longitude: 153.0 },
    { sequence: 2, capturedAt: 2_000, latitude: -27.1, longitude: 153.1 },
  ]
  const { control } = await mockBoat(page, { track: () => rows, trackId: () => id, course: false })
  control.trackingSessionId = 'A'
  await page.goto('/signalk-wakelogger/')
  const map = page.locator('#map')
  await expect(map).toHaveAttribute('data-track-recording-id', 'A')
  await expect(map).toHaveAttribute('data-track-point-count', '2')
  await expect(map).toHaveAttribute('data-track-south', '-27.1')
  // A genuinely new recording B with distinct geometry is reported by /tracking.
  id = 'B'
  control.trackingSessionId = 'B'
  rows = [
    { sequence: 1, capturedAt: 6_000, latitude: -30.0, longitude: 150.0 },
    { sequence: 2, capturedAt: 7_000, latitude: -30.5, longitude: 150.5 },
  ]
  await expect(map).toHaveAttribute('data-track-recording-id', 'B', { timeout: 12_000 })
  await expect(map).toHaveAttribute('data-track-point-count', '2')
  // B's geometry only; no A coordinate survives and no A->B line is drawn.
  await expect(map).toHaveAttribute('data-track-south', '-30.5')
  await expect(map).toHaveAttribute('data-track-north', '-30')
})

test('a delayed old /track response cannot restore A after /tracking reports B', async ({ page }) => {
  let id = 'A'
  let rows = [
    { sequence: 1, capturedAt: 1_000, latitude: -27.0, longitude: 153.0 },
    { sequence: 2, capturedAt: 2_000, latitude: -27.1, longitude: 153.1 },
  ]
  const { control } = await mockBoat(page, { track: () => rows, trackId: () => id, course: false })
  await page.goto('/signalk-wakelogger/')
  const map = page.locator('#map')
  await expect(map).toHaveAttribute('data-track-recording-id', 'A')
  await expect(map).toHaveAttribute('data-track-south', '-27.1')

  // Record every displayed identity/geometry transition so a rollback to A's
  // geometry after the app observed the B transition is detectable, not just
  // the final state.
  await page.evaluate(() => {
    window.__trackEvents = []
    const element = document.getElementById('map')
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        window.__trackEvents.push({
          t: Date.now(),
          attr: mutation.attributeName,
          oldValue: mutation.oldValue,
          value: element.getAttribute(mutation.attributeName),
          id: element.dataset.trackRecordingId,
          count: Number(element.dataset.trackPointCount || 0),
        })
      }
    }).observe(element, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [
        'data-track-recording-id',
        'data-track-point-count',
        'data-track-history-state',
        'data-track-observed-recording',
      ],
    })
  })

  // /tracking now reports B while A's next archive read is deliberately held.
  control.trackingSessionId = 'B'
  control.trackDelayOnce = 2500
  await page.evaluate(() => { window.__bObservedAt = Date.now() })
  await expect.poll(() => control.trackRequests.length, { timeout: 10_000 }).toBeGreaterThan(1)
  // The held request snapshotted A; by the time it returns the archive has B.
  id = 'B'
  rows = [
    { sequence: 1, capturedAt: 6_000, latitude: -30.0, longitude: 150.0 },
    { sequence: 2, capturedAt: 7_000, latitude: -30.5, longitude: 150.5 },
  ]
  // The delayed A response is discarded and B's geometry replaces it.
  await expect(map).toHaveAttribute('data-track-recording-id', 'B', { timeout: 25_000 })
  await expect(map).toHaveAttribute('data-track-point-count', '2')
  await expect(map).toHaveAttribute('data-track-south', '-30.5')
  // Past the delayed response window the old A geometry must not reappear.
  await page.waitForTimeout(4000)
  await expect(map).toHaveAttribute('data-track-recording-id', 'B')
  await expect(map).toHaveAttribute('data-track-south', '-30.5')

  const violations = await page.evaluate(() => {
    const events = window.__trackEvents || []
    const observed = events.find((entry) => entry.attr === 'data-track-observed-recording' && entry.value === 'B')
    // Only transitions after the app actually observed the B transition count:
    // an A acceptance that happened while B had not yet been observed is not a
    // rollback. With the fix the observed marker appears and A never returns.
    const since = observed ? observed.t + 250 : (window.__bObservedAt || 0) + 250
    return events.filter((entry) => entry.t > since && entry.id === 'A' && entry.count > 0)
  })
  expect(violations).toEqual([])
})

test('a failed archive read stays unresolved and reconciles instead of looking complete', async ({ page }) => {
  let rows = []
  const { control } = await mockBoat(page, { track: () => rows, course: false })
  control.trackFailuresRemaining = 1
  await page.goto('/signalk-wakelogger/')
  const map = page.locator('#map')
  await expect(map).toHaveAttribute('data-track-history-state', 'failed', { timeout: 10_000 })
  await expect(map).toHaveAttribute('data-track-point-count', '0')
  rows = [
    { sequence: 1, capturedAt: 1_000, latitude: -27.0, longitude: 153.0 },
    { sequence: 2, capturedAt: 2_000, latitude: -27.5, longitude: 153.5 },
    { sequence: 3, capturedAt: 3_000, latitude: -28.0, longitude: 154.0 },
  ]
  // A bounded retry (3s backoff) reconciles the real durable history.
  await expect(map).toHaveAttribute('data-track-point-count', '3', { timeout: 20_000 })
  await expect(map).toHaveAttribute('data-track-history-state', 'loaded')
  await expectFittedToTrack(map)
})

test('a pending recording with no archive points yet is not complete history', async ({ page }) => {
  let rows = []
  const { control } = await mockBoat(page, { track: () => rows, course: false })
  control.emptyRecordingId = 'rec-1'
  await page.goto('/signalk-wakelogger/')
  const map = page.locator('#map')
  await expect(map).toHaveAttribute('data-track-history-state', 'pending')
  await expect(map).toHaveAttribute('data-track-point-count', '0')
  rows = [
    { sequence: 1, capturedAt: 1_000, latitude: -27.0, longitude: 153.0 },
    { sequence: 2, capturedAt: 2_000, latitude: -27.5, longitude: 153.5 },
    { sequence: 3, capturedAt: 3_000, latitude: -28.0, longitude: 154.0 },
  ]
  await expect(map).toHaveAttribute('data-track-history-state', 'loaded', { timeout: 20_000 })
  await expect(map).toHaveAttribute('data-track-point-count', '3')
  await expectFittedToTrack(map)
})


test('a new desired plan supersedes the cached date and displays the foreign activation action', async ({ page }) => {
  const previous = { ...desired, revision: 2, courseId: 'race-plan-16', racePlanId: 16, name: 'SAGS 27/09/2026' }
  const today = { ...desired, revision: 3, courseId: 'race-plan-19', racePlanId: 19, name: 'SAGS 04/10/2026 · Course H', updatedAt: '2026-10-04T02:27:39Z' }
  let state = { desired: previous, cachedCourse: previous, acknowledgement: { revision: 2, status: 'applied' },
    native: { available: true, activeMatchesDesired: false, conflict: true, course: { activeRoute: { href: '/resources/routes/foreign', name: 'Foreign chart route' } } } }
  const { writes } = await mockBoat(page, { courseState: () => state, readiness: { ready: false, label: 'Offline race not ready', missing: ['Wake Logger course is not active', 'offline charts are not ready', 'vessel observations are not ready'], detail: 'Missing: Wake Logger course is not active; offline charts are not ready; vessel observations are not ready.' }, racePlan: { uploadMode: 'local_only', pack: { available: true, applicable: false, revision: 1886, racePlanId: 19, courseName: 'SAGS 04/10/2026 · Course H', startTime: '2026-10-04T02:44:00Z' } } })
  await page.goto('/signalk-wakelogger/')
  await page.locator('#course-tab').click()
  await expect(page.locator('#course-name')).toHaveText(previous.name)
  state = { ...state, desired: today, acknowledgement: { revision: 3, status: 'rejected', errorCode: 'native_route_conflict', activation: 'conflict' } }
  await expect(page.locator('#course-name')).toContainText(today.name, { timeout: 10000 })
  await expect(page.locator('#offline-readiness')).toContainText('3 items missing')
  await expect(page.locator('#offline-readiness')).toHaveAttribute('title', /Wake Logger course is not active/)
  await expect(page.locator('#active-status')).toContainText('Update rejected (native_route_conflict)')
  await expect(page.locator('#active-status')).toContainText('Another Signal K route is active')
  await expect(page.locator('#activate-course')).toHaveText(`Activate ${today.name}`)
  await expect(page.locator('#activate-course')).toBeEnabled()
  expect(writes).toEqual([])
  await page.locator('#activate-course').click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ method: 'POST', path: '/plugins/signalk-wakelogger/course/activate' })
  await expect(page.locator('#course-name')).not.toContainText('27/09/2026')
  await expect(page.locator('#race-plan-list')).toContainText('SAGS 04/10/2026 · Course H')
})


test('a newer Race Pack announces today before course delivery and cannot activate the old plan', async ({ page }) => {
  const previous = { ...desired, revision: 2, courseId: 'race-plan-16', racePlanId: 16, name: 'SAGS 27/09/2026', updatedAt: '2026-09-27T02:00:00Z' }
  const state = { desired: previous, cachedCourse: previous, acknowledgement: { revision: 2, status: 'applied' }, native: { available: true, activeMatchesDesired: true, conflict: false, course: { activeRoute: { href: ownedHref, pointIndex: 1 } } } }
  const { writes } = await mockBoat(page, { courseState: state, racePlan: { pack: { available: true, applicable: false, courseId: 'race-plan-19', racePlanId: 19, courseName: 'Course H', revision: 1886, generatedAt: '2026-10-04T02:27:39Z', startTime: '2026-10-04T02:44:00Z' } } })
  await page.goto('/signalk-wakelogger/')
  await page.locator('#course-tab').click()
  await expect(page.locator('#course-name')).toContainText('Course H')
  await expect(page.locator('#course-name')).toContainText('Course delivery pending')
  await expect(page.locator('#course-name')).toContainText('10/4/2026')
  await expect(page.locator('#course-name')).not.toContainText('27/09/2026')
  await expect(page.locator('#active-status')).toContainText('Desired course delivery pending')
  await expect(page.locator('#activate-course')).toBeDisabled()
  await expect(page.locator('#activate-course')).toHaveText('Waiting for desired course')
  await expect(page.locator('#advance-point')).toBeDisabled()
  await expect(page.locator('#map')).toHaveAttribute('data-course-point-count', '0')
  expect(writes).toEqual([])
})


test('heading and apparent-wind tack guides refresh without true wind and hide unsafe inputs', async ({ page }, testInfo) => {
  let heading = 30, awa = 30, awaAge = 0, positionAvailable = true, magneticOnly = false
  const measurement = value => ({ value, timestamp: new Date().toISOString() })
  const { writes } = await mockBoat(page, {
    navigationOverride: () => ({
      ...(positionAvailable ? { position: measurement({ latitude: -27.395, longitude: 153.18 }) } : {}),
      [magneticOnly ? 'headingMagnetic' : 'headingTrue']: measurement(heading * Math.PI / 180),
      courseOverGroundTrue: measurement(150 * Math.PI / 180),
    }),
    environment: () => ({ wind: { angleApparent: { value: awa * Math.PI / 180, timestamp: new Date(Date.now() - awaAge).toISOString() } } })
  })
  await page.goto('/signalk-wakelogger/')
  const map = page.locator('#map')
  await expect(map).toHaveAttribute('data-heading-guide-bearing', '30')
  await expect(map).toHaveAttribute('data-opposite-tack-bearing', '90')
  await expect(page.locator('.vessel-heading-guide')).toHaveCount(1)
  await expect(page.locator('.opposite-tack-guide')).toHaveCount(1)
  await expect(page.locator('.opposite-tack-guide')).toHaveAttribute('stroke-dasharray', '8 6')
  await expect(map).toHaveAttribute('aria-label', /30° apparent-wind tack guide 90° true/)
  await page.screenshot({ path: testInfo.outputPath('onboard-tack-guides.png'), fullPage: true })
  const bow = (await map.getAttribute('data-guide-origin')).split(',').map(Number)
  expect(bow[0]).toBeGreaterThan(-27.395)
  expect(bow[1]).toBeGreaterThan(153.18)
  heading = 90; awa = -30
  await expect(map).toHaveAttribute('data-heading-guide-bearing', '90', { timeout: 10000 })
  await expect(map).toHaveAttribute('data-opposite-tack-bearing', '30')
  awa = 90
  await expect(page.locator('.opposite-tack-guide')).toHaveCount(0)
  await expect(page.locator('.vessel-heading-guide')).toHaveCount(1)
  awa = -30; awaAge = 120000
  await expect(map).toHaveAttribute('data-opposite-tack-bearing', '')
  await expect(page.locator('.vessel-heading-guide')).toHaveCount(1)
  awaAge = 0; magneticOnly = true
  await expect(page.locator('.vessel-heading-guide')).toHaveCount(0)
  await expect(page.locator('.opposite-tack-guide')).toHaveCount(0)
  magneticOnly = false; positionAvailable = false
  await expect(map).toHaveAttribute('data-heading-guide-bearing', '')
  expect(writes).toEqual([])
})
