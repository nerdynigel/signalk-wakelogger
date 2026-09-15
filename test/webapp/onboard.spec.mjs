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

async function mockBoat(page, { charts = {}, conflict = false, missingDirection = false } = {}) {
  const writes = []
  let uploadMode = 'local_only'
  const external = []
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
      return json({ uploadMode, paired: true, recording: true, connectionState: uploadMode === 'automatic' ? 'online' : 'recording_locally', queue: { messageCount: 123, currentSequence: 200, acknowledgedSequence: 77 } })
    }
    if (pathname === '/plugins/signalk-wakelogger/course') {
      return json({ desired, cachedCourse: desired, acknowledgement: { v: 1, revision: 7, status: 'applied' }, routePoints: points,
        native: { available: true, course: navigation, ownedRouteId, activeMatchesDesired: navigation.activeRoute.href === ownedHref, conflict: navigation.activeRoute.href !== ownedHref },
        credentials: { password: secret },
      })
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
    if (pathname === '/signalk/v1/api/vessels/self/navigation') return json({ position: { value: { latitude: -27.395, longitude: 153.18 }, timestamp: new Date().toISOString() }, speedOverGround: { value: 3.2 }, ...(missingDirection ? {} : { courseOverGroundTrue: { value: 1.1 } }) })
    if (pathname === '/signalk/v1/api/vessels/self/navigation/position') return json({ value: { latitude: -27.395, longitude: 153.18 }, timestamp: new Date().toISOString() })
    if (pathname === '/plugins/signalk-wakelogger/status') return json({ connectionState: 'recording_locally', uploadMode: 'local_only', queueMessageCount: 123, credentials: { password: secret } })
    return route.continue()
  })
  return { writes, external }
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
