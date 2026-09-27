import { SignalKClient, CourseProgressionService, RaceProgressionService } from './api-client.mjs'
import { ChartSourceService, courseBounds, coversBounds } from './chart-sources.mjs'
import { coursePoints, raceProgress } from './course-progress.mjs'
import { LocalChartVerifier } from './map-preparation.mjs'
import { trackingPresentation } from './tracking-controls.mjs'
import { racePlanPresentation } from './race-plan.mjs'
import { describeNavigationFailure } from './navigation-errors.mjs'
import { offlineReadinessPresentation, localOnlyWarning } from './offline-readiness.mjs'
import { instrumentReadings, formatReading } from './instruments.mjs'
import { bootstrapTrack, appendTrackPoint, needsRebootstrap, MAX_DISPLAY_TRACK_POINTS } from './track.mjs'

const $ = id => document.getElementById(id)
const client = new SignalKClient()
const progression = new CourseProgressionService(client)
const raceProgressionClient = new RaceProgressionService(client)
const charts = new ChartSourceService(client)
const verifier = new LocalChartVerifier()
const L = window.L
const map = L.map('map', { zoomControl: true }).setView([0, 0], 2)
const routeLayer = L.layerGroup().addTo(map)
const vesselLayer = L.layerGroup().addTo(map)
const trackLine = L.polyline([], { color: '#526671', weight: 2, opacity: 0.65 }).addTo(map)
let track = [], status = null, progress = null, sources = [], selectedChart = null, tileLayer = null
let trackingStatus = null, trackingChanging = false, trackingRequest = 0
let raceProgression = null, applyingProgression = false
const CLIENT_KEY = 'wakelogger-onboard-client'
const CONTROL_KEY = 'wakelogger-navigation-control'
let clientId = localStorage.getItem(CLIENT_KEY) || ''
if (!clientId) {
  clientId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`)
  try { localStorage.setItem(CLIENT_KEY, clientId) } catch { /* storage may be unavailable */ }
}
let navigationControl = false
try { navigationControl = localStorage.getItem(CONTROL_KEY) === '1' } catch { navigationControl = false }
let racePlan = null, offlineReadiness = null
let navigationData = {}, environmentData = {}, signalKAvailable = null, environmentUnavailable = false
let trackBootstrapped = false, trackLoading = false, trackRecordingId = null, fixesSinceBootstrap = 0, trackNeedsRebootstrap = true, trackResumeRequested = false
let lastCourseKey = '', lastChartsAt = 0, busy = false, polling = false, selectedPointDirty = false, defaultPanelChosen = false, instrumentPolling = false, instrumentRequest = 0
const notice = message => { $('notice').textContent = message || '' }
const metric = (id, number, suffix, decimals = 1) => { $(id).textContent = number === null ? '—' : `${number.toFixed(decimals)}${suffix}` }
const safeText = text => { const node = document.createElement('span'); node.textContent = text; return node }
const attempt = promise => promise.then(value => ({ value }), error => ({ error }))

function reportDiagnostic(error) {
  if (!error || typeof error.toDiagnostic !== 'function') return
  const diagnostic = error.toDiagnostic()
  if (!diagnostic.path) return
  client.request('/plugins/signalk-wakelogger/diagnostics', { method: 'POST', operation: 'report-diagnostic', body: JSON.stringify(diagnostic) }).catch(() => {})
}

function fitCourse() {
  const points = progress?.points || []
  if (points.length) map.fitBounds(points.map(point => [point.latitude, point.longitude]), { padding: [35, 55], maxZoom: 15, animate: false })
  else if (progress?.position) map.setView([progress.position.latitude, progress.position.longitude], 13)
}

function renderCourse() {
  const course = status.desired?.action === 'clear' ? status.desired : status.cachedCourse || status.desired
  $('course-name').textContent = course?.action !== 'clear' && course?.name ? course.name : 'Onboard navigation'
  if (!trackingStatus) $('cloud-state').textContent = 'Signal K connected'
  const ack = status.acknowledgement
  $('active-status').textContent = progress.matches ? `Wake Logger course active · Revision ${course?.revision ?? '—'}` : progress.points.length ? `Wake Logger course not currently active${status.native?.course?.activeRoute?.name ? ` · Signal K: ${status.native.course.activeRoute.name}` : ''}` : 'No course selected in Wake Logger'
  if (ack?.status === 'rejected') $('active-status').textContent += ` · Update rejected${ack.errorCode ? ` (${ack.errorCode})` : ''}; last usable course retained`
  $('activate-course').disabled = busy || !progress.points.length || !status.native?.available || progress.matches
  $('advance-point').disabled = busy || !progress.matches || progress.index === null || progress.index >= progress.points.length - 1
  $('point-index').disabled = busy || !progress.matches
  $('set-point').disabled = busy || !progress.matches
  const key = `${course?.courseId}:${course?.revision}:${progress.reverse}`
  const courseChanged = key !== lastCourseKey
  if (courseChanged) {
    verifier.cancel()
    $('point-index').replaceChildren(...progress.points.map((point, index) => new Option(`${index + 1}. ${point.name || 'Course point'}`, index)))
    selectedPointDirty = false
  }
  if (!selectedPointDirty && progress.index !== null) $('point-index').value = String(progress.index)
  $('point-number').textContent = progress.index === null ? 'NO ACTIVE COURSE' : progress.index === 0 ? progress.reverse ? 'FINISH' : 'START' : progress.index === progress.points.length - 1 ? progress.reverse ? 'START' : 'FINISH' : `MARK ${progress.index} OF ${Math.max(0, progress.points.length - 2)}`
  $('next-mark').textContent = progress.next?.name || 'No next mark'
  $('next-note').textContent = progress.next?.notes || ''
  $('previous-mark').textContent = `Previous: ${progress.previous?.name || 'unavailable'}`
  metric('distance', progress.distanceNm, ' NM', 2)
  metric('bearing', progress.bearingDeg, '°', 0)
  metric('vmg', progress.vmgKn, ' kn')
  metric('xte', progress.xteM, ' m', 0)
  metric('ttg', progress.timeToGo === null ? null : progress.timeToGo / 60, ' min', 0)
  const eta = progress.eta ? new Date(progress.eta) : null
  $('eta').textContent = eta && Number.isFinite(eta.getTime()) ? eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
  $('progress-value').textContent = progress.pointPercent === null ? '—' : `${progress.pointPercent}%`
  $('course-progress').value = progress.pointPercent ?? 0
  routeLayer.clearLayers()
  const coordinates = progress.points.map(p => [p.latitude, p.longitude])
  if (coordinates.length) L.polyline(coordinates, { color: '#006a85', weight: 3 }).addTo(routeLayer)
  if (progress.index !== null && progress.previous) L.polyline(coordinates.slice(progress.index - 1, progress.index + 1), { color: '#db7718', weight: 6 }).addTo(routeLayer)
  progress.points.forEach((point, index) => {
    const label = index === 0 ? progress.reverse ? 'F' : 'S' : index === progress.points.length - 1 ? progress.reverse ? 'S' : 'F' : String(index)
    const state = progress.index === index ? ' next' : progress.index !== null && index < progress.index ? ' passed' : ''
    L.marker([point.latitude, point.longitude], { icon: L.divIcon({ className: `mark${state}`, html: label, iconSize: [30, 30], iconAnchor: [15, 15] }) })
      .bindTooltip(safeText(point.name || label)).addTo(routeLayer)
  })
  $('map').dataset.coursePointCount = String(progress.points.length)
  vesselLayer.clearLayers()
  if (progress.position) {
    const point = [progress.position.latitude, progress.position.longitude]
    const icon = progress.direction === null
      ? L.divIcon({ className: 'mark', html: '●', iconSize: [20, 20], iconAnchor: [10, 10] })
      : L.divIcon({ className: 'vessel-icon', html: `<span style="transform:rotate(${progress.direction}deg)"></span>`, iconSize: [20, 28], iconAnchor: [10, 14] })
    L.marker(point, { icon }).bindTooltip('Vessel').addTo(vesselLayer)
    if (trackBootstrapped) {
      const before = track.length
      track = appendTrackPoint(track, point)
      fixesSinceBootstrap += 1
      if (track.length === before && before >= MAX_DISPLAY_TRACK_POINTS) trackNeedsRebootstrap = true
    }
    trackLine.setLatLngs(track)
  }
  $('centre-vessel').disabled = !progress.position
  if (courseChanged) { fitCourse(); lastCourseKey = key; renderChartReadiness(); reportMap('unknown') }
}

// The onboard map track comes from a durable onboard archive, not from
// page-open time and not from the delivery outbox. Bootstrap from the bounded
// local API on load and again whenever the recording changes, the page resumes,
// or enough new fixes have arrived that the whole-trip geometry should be
// recomputed (which preserves the departure instead of dropping it).
async function bootstrapTrackFromDurable() {
  if (trackLoading) return
  trackLoading = true
  try {
    const response = await client.request(`/plugins/signalk-wakelogger/track?maxPoints=${MAX_DISPLAY_TRACK_POINTS}`, { operation: 'read-track' })
    if (response && Array.isArray(response.points)) {
      track = bootstrapTrack(response)
      trackBootstrapped = true
      trackRecordingId = response.trackingSessionId || response.recording?.id || null
      fixesSinceBootstrap = 0
      trackNeedsRebootstrap = false
      trackLine.setLatLngs(track)
    }
  } catch { /* Keep retrying on the next poll; never block instruments. */ }
  finally { trackLoading = false }
}

function renderInstruments() {
  const grid = $('instruments-grid')
  if (!grid) return
  const view = instrumentReadings({ navigation: navigationData, environment: environmentData, now: Date.now() })
  grid.replaceChildren(...view.readings.map(instrumentTile))
  const state = $('signal-k-state')
  if (signalKAvailable === false) state.textContent = 'Signal K unavailable — instrument updates paused'
  else if (environmentUnavailable) state.textContent = 'Signal K connected · environment sensors unavailable'
  else state.textContent = `Signal K connected · ${view.available}/${view.total} readings live`
}

function instrumentTile(reading) {
  const tile = document.createElement('div')
  tile.className = 'instrument'
  tile.dataset.available = String(reading.available)
  tile.dataset.freshness = reading.freshness
  tile.dataset.stale = String(reading.freshness === 'stale')
  if (reading.freshness === 'stale' && reading.ageSeconds !== null) tile.dataset.age = String(reading.ageSeconds)
  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = reading.label
  const value = document.createElement('span')
  value.className = 'value'
  value.textContent = formatReading(reading)
  const meta = document.createElement('span')
  meta.className = 'meta'
  const bits = []
  bits.push(reading.source === 'derived' ? 'derived' : 'measured')
  if (reading.reference) bits.push(reading.reference)
  if (reading.freshness === 'unknown') bits.push('timestamp unknown')
  else if (reading.freshness === 'missing') bits.push('no data')
  else if (reading.freshness === 'stale') bits.push('stale')
  else if (reading.ageSeconds !== null) bits.push(`${reading.ageSeconds}s ago`)
  meta.textContent = bits.join(' · ')
  tile.append(label, value, meta)
  return tile
}

function renderOfflineReadiness() {
  const element = $('offline-readiness')
  if (!element) return
  const view = offlineReadinessPresentation(offlineReadiness)
  if (!view.known) { element.textContent = ''; element.dataset.ready = 'unknown'; return }
  element.dataset.ready = String(view.ready)
  element.textContent = view.ready ? 'Offline race ready' : `Offline race not ready — ${view.missing.length} item${view.missing.length === 1 ? '' : 's'} missing`
  element.title = view.detail
}

function renderChartReadiness() {
  const margin = Number($('chart-margin').value)
  const bounds = courseBounds(progress?.points || [], margin)
  $('chart-readiness').textContent = selectedChart?.local ? 'Local chart available · coverage not yet verified' : selectedChart?.cached ? 'Signal K cached source · offline coverage unverified' : selectedChart ? 'Online chart · internet may be required' : 'No basemap · vessel and course remain available'
  $('chart-coverage').textContent = bounds ? `Preparation area: course + ${margin} km${selectedChart?.bounds ? coversBounds(selectedChart, bounds) ? ' · Within chart bounds' : ' · Extends beyond chart bounds' : ''}` : 'Select a course and a margin from 5 to 20 km.'
  $('verify-chart').disabled = !selectedChart?.local || !bounds || !coversBounds(selectedChart, bounds)
}

function useChart(chart) {
  verifier.cancel()
  if (tileLayer) map.removeLayer(tileLayer)
  selectedChart = chart
  tileLayer = null
  if (chart) {
    const attribution = safeText(chart.attribution).innerHTML
    const options = { minZoom: chart.minZoom, maxZoom: chart.maxZoom, attribution }
    tileLayer = chart.type === 'WMS' ? L.tileLayer.wms(chart.url, { ...options, layers: chart.layers, format: 'image/png', transparent: true }) : L.tileLayer(chart.url, options)
    tileLayer.on('tileerror', () => { $('map-status').textContent = 'Chart tiles unavailable — vessel and course remain visible' })
    tileLayer.addTo(map)
    $('map-status').textContent = chart.local ? 'Chart served by this Signal K server' : chart.cached ? 'Signal K chart cache — coverage depends on prepared tiles' : 'Online chart selected'
  } else $('map-status').textContent = 'Course map available without a basemap'
  renderChartReadiness()
  reportMap(chart ? chart.local ? 'unknown' : 'online_only' : 'unavailable')
}

async function discoverCharts() {
  try {
    sources = await charts.discover()
    $('chart-source').replaceChildren(new Option('No basemap', ''), ...sources.map(source => new Option(`${source.name}${source.local ? ' · local' : source.cached ? ' · cached' : ' · online'}`, source.id)))
    const current = sources.find(source => source.id === selectedChart?.id)
    const bounds = courseBounds(progress?.points || [], Number($('chart-margin').value))
    const preferred = current || sources.find(source => !source.online && (!source.bounds || !bounds || coversBounds(source, bounds)))
    if (JSON.stringify(preferred || null) !== JSON.stringify(selectedChart)) useChart(preferred || null)
    $('chart-source').value = selectedChart?.id || ''
  } catch { useChart(null) }
  lastChartsAt = Date.now()
}

// Instruments are polled on their own bounded loop, independent of the course,
// Race Pack, trip and track requests. A stalled or failed course/pack request
// therefore never freezes instrument updates or their freshness.
async function refreshInstruments() {
  if (instrumentPolling) return
  instrumentPolling = true
  const thisRequest = ++instrumentRequest
  try {
    const [navigationResult, environmentResult] = await Promise.all([
      attempt(client.request('/signalk/v1/api/vessels/self/navigation', { operation: 'read-navigation', timeoutMs: 2500 })),
      attempt(client.request('/signalk/v1/api/vessels/self/environment', { operation: 'read-environment', timeoutMs: 2500 })),
    ])
    if (thisRequest !== instrumentRequest) return
    if (!navigationResult.error) {
      navigationData = navigationResult.value || {}
      signalKAvailable = true
    } else {
      signalKAvailable = false
      if ([401, 403].includes(navigationResult.error?.status)) $('login').hidden = false
    }
    if (!environmentResult.error) { environmentData = environmentResult.value || {}; environmentUnavailable = false }
    else environmentUnavailable = true
    renderInstruments()
  } finally { instrumentPolling = false }
}

async function poll() {
  if (polling) return
  polling = true
  const thisPoll = ++pollSequence
  try {
    const [statusResult, calcResult, progressionResult, racePlanResult, readinessResult] = await Promise.all([
      attempt(client.request('/plugins/signalk-wakelogger/course', { operation: 'read-course', timeoutMs: 4000 })),
      attempt(client.request('/signalk/v2/api/vessels/self/navigation/course/calcValues', { operation: 'read-calc-values', timeoutMs: 4000 })),
      attempt(client.request('/plugins/signalk-wakelogger/progression', { operation: 'read-progression', timeoutMs: 4000 })),
      attempt(client.request('/plugins/signalk-wakelogger/race-plan', { operation: 'read-race-plan', timeoutMs: 4000 })),
      attempt(client.request('/plugins/signalk-wakelogger/offline-readiness', { operation: 'read-offline-readiness', timeoutMs: 4000 })),
    ])

    if (readinessResult.value) offlineReadiness = readinessResult.value
    raceProgression = progressionResult.value ?? null
    racePlan = racePlanResult.value ?? null

    if (statusResult.value) {
      status = statusResult.value
      if (statusResult.value.offlineReadiness) offlineReadiness = statusResult.value.offlineReadiness
      const nativeRoute = status.native?.ownedRouteId
        ? await client.request(`/signalk/v2/api/resources/routes/${encodeURIComponent(status.native.ownedRouteId)}`).catch(() => null)
        : null
      progress = raceProgress(status, navigationData, calcResult.value ?? {}, nativeRoute)
      $('login').hidden = true
      renderCourse()
      if (!defaultPanelChosen) { selectPanel(progress.points.length ? 'race' : 'instruments'); defaultPanelChosen = true }
    } else {
      const error = statusResult.error
      if ([401, 403].includes(error?.status)) $('login').hidden = false
      notice(error?.message || 'Signal K course state unavailable.')
      $('cloud-state').textContent = 'Signal K unavailable'
      reportDiagnostic(error)
    }

    renderOfflineReadiness()
    renderProgression()
    renderRacePlan()
    if (navigationControl) {
      const result = await claimControl(false)
      if (result && !result.held) raceProgression = { ...(raceProgression ?? {}), control: result }
      else if (result?.held) {
        navigationControl = false
        try { localStorage.setItem(CONTROL_KEY, '0') } catch { /* ignore */ }
        notice('Navigation control moved to another device; this page is now a viewer.')
      }
    }
    if (raceProgression?.mode === 'auto' && raceProgression.pending && !raceProgression.pending.wrongSide && navigationControl) await applyProgression()
    const serverSessionId = trackingStatus?.trackingSessionId ?? null
    if (trackBootstrapped && serverSessionId !== trackRecordingId) trackNeedsRebootstrap = true
    if (trackNeedsRebootstrap || needsRebootstrap({ trackLength: track.length, fixesSinceBootstrap, resumed: trackResumeRequested })) {
      trackResumeRequested = false
      await bootstrapTrackFromDurable()
    }
    if (Date.now() - lastChartsAt > 60_000) await discoverCharts()
  } finally { if (thisPoll === pollSequence) polling = false }
}

async function command(action, context = {}) {
  if (busy) return
  busy = true
  try { await action(); selectedPointDirty = false; notice('Navigation updated.'); await poll() }
  catch (error) { notice(describeNavigationFailure(error, context)); reportDiagnostic(error) }
  finally { busy = false; if (progress) renderCourse() }
}

function renderProgression() {
  const element = $('progression-status')
  if (!element) return
  const control = $('navigation-control')
  if (control) {
    const heldByOther = raceProgression?.control?.active === true && raceProgression.control.clientId !== clientId
    control.setAttribute('aria-pressed', String(navigationControl))
    control.textContent = navigationControl ? 'Navigation control: this device' : 'Take navigation control'
    control.disabled = heldByOther && !navigationControl
    control.title = heldByOther ? 'Another onboard device is controlling navigation' : 'Only the controlling device advances the course automatically'
  }
  const labels = { auto: 'Automatic', suggest: 'Suggest', off: 'Off' }
  const mode = raceProgression?.mode
  const pending = raceProgression?.pending
  if (!mode) { element.textContent = ''; $('progression-actions').hidden = true; return }
  const detail = pending && !pending.wrongSide ? ` · ${pending.type} detected at point ${pending.pointIndex + 1}` : ''
  element.textContent = `Mark detection: ${labels[mode] ?? mode}${detail}`
  $('progression-actions').hidden = !(mode === 'suggest' && pending && !pending.wrongSide && navigationControl)
}

function renderRacePlan() {
  const list = $('race-plan-list')
  if (!list) return
  const view = racePlanPresentation(racePlan)
  const authority = $('race-authority')
  authority.textContent = `Race plan authority: ${view.authority}`
  authority.dataset.authority = view.authority === 'Onboard' ? 'onboard' : 'cloud'
  authority.dataset.pack = view.packAvailable ? 'ready' : 'missing'
  authority.title = `${view.authorityDetail} · ${view.packStatus}`
  const warning = $('race-plan-warning')
  warning.textContent = view.warning || ''
  warning.hidden = !view.warning
  list.replaceChildren()
  if (!view.packAvailable) {
    const empty = document.createElement('p')
    empty.className = 'muted'
    empty.textContent = view.packStatus
    list.append(empty)
    return
  }
  const heading = document.createElement('p')
  heading.className = 'race-plan-heading'
  const pieces = [view.packStatus]
  if (view.lastUpdated) pieces.push(view.historyOnly ? `Last onboard plan ${view.lastUpdated} (historical)` : `Updated ${view.lastUpdated}`)
  heading.textContent = pieces.join(' · ')
  list.append(heading)
  if (view.currentLeg) {
    const current = document.createElement('div')
    current.className = 'race-plan-current'
    current.dataset.leg = 'current'
    current.append(racePlanLeg(view.currentLeg, 'Next leg'))
    list.append(current)
  }
  for (const leg of view.remainingLegs.slice(1)) {
    const row = document.createElement('div')
    row.className = 'race-plan-leg'
    row.dataset.leg = 'remaining'
    row.append(racePlanLeg(leg))
    list.append(row)
  }
}

function racePlanLeg(leg, eyebrow) {
  const fragment = document.createDocumentFragment()
  if (eyebrow) {
    const label = document.createElement('span')
    label.className = 'eyebrow'
    label.textContent = eyebrow
    fragment.append(label)
  }
  const name = document.createElement('strong')
  name.textContent = leg.name
  fragment.append(name)
  const detail = document.createElement('span')
  if (leg.outOfRange) {
    detail.textContent = 'Forecast unavailable for the recalculated time'
  } else {
    const parts = []
    if (leg.summary) parts.push(leg.summary)
    if (leg.wind) parts.push(leg.wind)
    if (leg.pointOfSail) parts.push(leg.pointOfSail)
    if (leg.usedObserved) parts.push('observed')
    if (leg.confidence) parts.push(`${leg.confidence} confidence`)
    detail.textContent = parts.join(' · ') || 'No deterministic recommendation available'
  }
  fragment.append(detail)
  return fragment
}

// Only the leased navigation controller may auto-apply a detection, and the
// advancement is an idempotent absolute point index bound to the selected
// course revision and the still-current native point. A second client (or a
// retry after a lost response) therefore cannot advance twice, and a viewer
// never advances at all.
async function claimControl(release = false) {
  try {
    const result = await client.request('/plugins/signalk-wakelogger/progression/control', { method: 'POST', operation: 'navigation-control', timeoutMs: 3000, body: JSON.stringify({ clientId, release }) })
    return result?.control ?? null
  } catch (error) {
    if (error?.status === 409) return { held: true }
    reportDiagnostic(error)
    return null
  }
}

async function applyProgression() {
  if (applyingProgression || !navigationControl) return
  const pending = raceProgression?.pending
  const href = status?.native?.course?.activeRoute?.href
  const revision = status?.desired?.revision
  if (!pending || pending.wrongSide || !href) return
  if (raceProgression.control?.clientId !== clientId) return
  if (pending.revision !== revision || pending.pointIndex !== progress?.index) return
  const target = pending.pointIndex + 1
  if (!Number.isInteger(target) || target >= (progress?.points?.length ?? 0)) return
  applyingProgression = true
  try {
    await progression.setPoint(target, progress.points.length, href)
    await raceProgressionClient.resolve('accepted', pending.pointIndex)
    notice(`Mark ${pending.pointIndex + 1} rounding accepted.`)
  } catch (error) {
    notice(`${describeNavigationFailure(error, { markNumber: pending.pointIndex + 1 })} Set the point manually if the rounding was missed.`)
    reportDiagnostic(error)
  } finally { applyingProgression = false }
}

$('navigation-control').onclick = async () => {
  if (navigationControl) {
    navigationControl = false
    try { localStorage.setItem(CONTROL_KEY, '0') } catch { /* ignore */ }
    await claimControl(true)
    notice('Navigation control released. This device is now a viewer.')
  } else {
    const control = await claimControl(false)
    if (control?.clientId === clientId) {
      navigationControl = true
      try { localStorage.setItem(CONTROL_KEY, '1') } catch { /* ignore */ }
      notice('Navigation control enabled on this device.')
    } else {
      navigationControl = false
      notice('Another device is already controlling navigation for this course.')
    }
  }
  renderProgression()
}

$('progression-accept').onclick = () => {
  if (!navigationControl) { notice('Enable navigation control on this device before accepting a rounding.'); return }
  const pending = raceProgression?.pending
  if (!pending) return
  return command(async () => {
    await progression.setPoint(pending.pointIndex + 1, progress.points.length, status.native.course.activeRoute.href)
    await raceProgressionClient.resolve('accepted', pending.pointIndex)
  }, { markNumber: pending.pointIndex + 1 })
}
$('progression-dismiss').onclick = async () => {
  try {
    await raceProgressionClient.resolve('dismissed', raceProgression.pending.pointIndex)
    raceProgression = { ...raceProgression, pending: null }
    renderProgression()
    notice('Rounding dismissed.')
  } catch (error) { notice(error.message); reportDiagnostic(error) }
}
$('fit-course').onclick = fitCourse
$('centre-vessel').onclick = () => { if (progress?.position) map.setView([progress.position.latitude, progress.position.longitude], Math.max(12, map.getZoom())) }
$('activate-course').onclick = () => command(() => progression.activate())
$('advance-point').onclick = () => command(() => progression.advance(status.native.course.activeRoute.href), { markName: progress?.next?.name })
$('point-index').onchange = () => { selectedPointDirty = true }
$('set-point').onclick = () => command(() => progression.setPoint(Number($('point-index').value), progress.points.length, status.native.course.activeRoute.href), { markName: progress?.points[Number($('point-index').value)]?.name })
$('chart-source').onchange = () => { useChart(sources.find(source => source.id === $('chart-source').value) || null); reportMap('unknown') }
$('chart-margin').onchange = () => { verifier.cancel(); renderChartReadiness(); reportMap('unknown') }
$('login').onsubmit = async event => {
  event.preventDefault()
  const data = new FormData(event.currentTarget)
  try { await client.signIn(data.get('username'), data.get('password')); event.currentTarget.reset(); notice(''); await poll() }
  catch (error) { notice(error.message) }
}
$('sign-out').onclick = () => { client.signOut(); $('login').hidden = false; notice('Signed out of the onboard app.') }

function reportMap(mapStatus, revision = status?.desired?.revision) {
  if (!revision) return Promise.resolve()
  return client.request('/plugins/signalk-wakelogger/course/map-readiness', { method: 'POST', operation: 'set-map-readiness', body: JSON.stringify({ revision, status: mapStatus }) }).catch(() => {})
}
$('verify-chart').onclick = async () => {
  const revision = status?.desired?.revision
  const chart = selectedChart
  const bounds = courseBounds(progress?.points || [], Number($('chart-margin').value))
  $('verify-chart').disabled = true
  $('cancel-verify').hidden = false
  await reportMap('preparing', revision)
  try {
    const result = await verifier.verify(chart, bounds, {
      maxZoom: Number($('verify-zoom').value), maxBytes: Number($('verify-limit').value) * 1024 * 1024,
      onProgress: info => { $('chart-readiness').textContent = `Checking local chart · ${info.checked}/${info.total} tiles · ${(info.bytes / 1024 / 1024).toFixed(1)} MB read` }
    })
    if (revision !== status?.desired?.revision || chart !== selectedChart) return
    $('chart-readiness').textContent = `Offline ready for checked area · zoom ${result.minZoom}–${result.maxZoom} · ${(result.bytes / 1024 / 1024).toFixed(1)} MB verified (not total cache size)`
    await reportMap('offline_ready', revision)
  } catch (error) {
    $('chart-readiness').textContent = error.name === 'AbortError' ? 'Chart check cancelled · offline readiness unconfirmed' : error.message
    await reportMap('unknown', revision)
  } finally { $('verify-chart').disabled = false; $('cancel-verify').hidden = true }
}
$('cancel-verify').onclick = () => verifier.cancel()
$('cache-jobs').onclick = async () => {
  try {
    const jobs = await charts.cacheJobs()
    $('cache-status').replaceChildren()
    if (!jobs) { $('cache-status').textContent = 'This Signal K Charts version has no preparation API. Install local MBTiles through Signal K Charts.'; return }
    const entries = Array.isArray(jobs) ? jobs : Object.values(jobs)
    if (!entries.length) { $('cache-status').textContent = 'No chart preparation jobs. Prepare licensed maps in Signal K Charts; verify local coverage before departure.'; return }
    for (const job of entries) {
      const row = document.createElement('div')
      row.textContent = `${job.chartName || 'Chart'}: ${job.status || job.state || 'unknown'} · ${job.downloadedTiles || 0} downloaded · ${job.failedTiles || 0} failed. Offline coverage unverified.`
      if (job.id && !['completed', 'complete', 'stopped'].includes(String(job.status || job.state).toLowerCase())) {
        const cancel = document.createElement('button'); cancel.textContent = 'Cancel preparation'
        cancel.onclick = async () => { try { await charts.cancelJob(job.id); row.textContent = 'Preparation cancellation requested.' } catch (error) { notice(error.message) } }
        row.append(cancel)
      }
      $('cache-status').append(row)
    }
  } catch (error) { $('cache-status').textContent = error.message }
}

function renderTracking() {
  const view = trackingPresentation(trackingStatus)
  $('live-tracking').setAttribute('aria-checked', String(view.enabled))
  $('live-tracking').disabled = trackingChanging || !view.available
  $('live-tracking').setAttribute('aria-busy', String(trackingChanging))
  $('tracking-mode').textContent = trackingChanging ? 'Saving…' : view.mode
  $('tracking-description').textContent = view.description
  $('upload-queue').textContent = view.queue
  if (trackingStatus) $('cloud-state').textContent = !view.available ? 'Not paired' : !view.enabled ? 'Recording locally' : trackingStatus.connectionState === 'online' ? 'Live connected' : 'Cloud offline'
}
async function refreshTracking() {
  if (trackingChanging) return
  const request = ++trackingRequest
  try {
    const next = await client.request('/plugins/signalk-wakelogger/tracking', { operation: 'read-tracking' })
    if (request !== trackingRequest || trackingChanging) return
    trackingStatus = next
  } catch {
    if (request !== trackingRequest || trackingChanging) return
    trackingStatus = null
  }
  renderTracking()
}
$('live-tracking').onclick = async () => {
  if (trackingChanging || !trackingPresentation(trackingStatus).available) return
  const uploadMode = trackingStatus.uploadMode === 'automatic' ? 'local_only' : 'automatic'
  let warning = null
  if (uploadMode === 'local_only') {
    // Pre-switch warning: local-only stays possible, but the crew is told
    // precisely what is missing before onboard sail planning is relied upon.
    const readiness = await client.request('/plugins/signalk-wakelogger/offline-readiness', { operation: 'read-offline-readiness' }).catch(() => null)
    if (readiness) offlineReadiness = readiness
    warning = localOnlyWarning(readiness)
    renderOfflineReadiness()
  }
  trackingChanging = true
  ++trackingRequest
  renderTracking()
  try {
    trackingStatus = await client.request('/plugins/signalk-wakelogger/tracking', { method: 'POST', operation: 'set-tracking', body: JSON.stringify({ uploadMode }) })
    notice(warning || (uploadMode === 'local_only' ? 'Live tracking off. Your trip continues recording onboard.' : 'Live tracking on. Saved history uploads when connected.'))
  } catch (error) {
    try { trackingStatus = await client.request('/plugins/signalk-wakelogger/tracking', { operation: 'read-tracking' }) }
    catch { trackingStatus = null }
    notice(error.status === 503 ? 'The setting could not be saved. Current recorder status is shown below.' : error.message)
    reportDiagnostic(error)
    if ([401, 403].includes(error.status)) {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen().catch(() => {})
      setFullscreen(false)
      $('login').hidden = false
    }
  } finally { trackingChanging = false; renderTracking() }
}

const tabNames = ['instruments', 'race', 'course', 'charts']
function selectPanel(name, focus = false) {
  for (const item of tabNames) {
    const selected = item === name
    $(`${item}-tab`).setAttribute('aria-selected', String(selected))
    $(`${item}-tab`).tabIndex = selected ? 0 : -1
    $(`${item}-panel`).hidden = !selected
  }
  if (focus) $(`${name}-tab`).focus()
}
for (const name of tabNames) {
  $(`${name}-tab`).onclick = () => selectPanel(name)
  $(`${name}-tab`).onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = tabNames.indexOf(name)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabNames.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : tabNames.length - 1)) % tabNames.length
    selectPanel(tabNames[next], true)
  }
}
const chartplotter = $('chartplotter')
const screen = window.matchMedia('(max-width: 760px)')
function resizeMap() {
  chartplotter.dataset.screen = screen.matches ? 'mobile' : 'desktop'
  requestAnimationFrame(() => map.invalidateSize({ animate: false }))
}
screen.addEventListener('change', () => {
  resizeMap()
  requestAnimationFrame(fitCourse)
})
new ResizeObserver(resizeMap).observe(chartplotter)
resizeMap()
function setFullscreen(active) {
  chartplotter.classList.toggle('is-fullscreen', active)
  document.body.classList.toggle('chartplotter-fullscreen', active)
  $('fullscreen').textContent = active ? 'Exit full screen' : 'Full screen'
  $('fullscreen').setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen')
  $('fullscreen').setAttribute('aria-pressed', String(active))
  resizeMap()
  requestAnimationFrame(fitCourse)
}
$('fullscreen').onclick = async () => {
  const active = chartplotter.classList.contains('is-fullscreen') || document.fullscreenElement === chartplotter
  if (active) {
    if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen().catch(() => {})
    setFullscreen(false)
  } else {
    // Browser fullscreen is not available on every onboard mobile browser.
    // The fixed viewport presentation provides the same controls there.
    setFullscreen(true)
    if (chartplotter.requestFullscreen) await chartplotter.requestFullscreen().catch(() => {})
  }
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) setFullscreen(false)
})
// A backgrounded mobile browser can suspend timers; on resume, re-request the
// whole-trip geometry so a gap while suspended cannot leave the map short.
document.addEventListener('visibilitychange', () => { if (!document.hidden) trackResumeRequested = true })
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.fullscreenElement) setFullscreen(false)
})

let pollSequence = 0
await Promise.all([poll(), refreshInstruments(), refreshTracking()])
setInterval(() => { if (!document.hidden) { poll(); refreshTracking() } }, 3000)
// Instruments refresh on their own cadence so a hanging course/pack request
// cannot delay live readings or their freshness.
setInterval(() => { if (!document.hidden) refreshInstruments() }, 2000)
window.addEventListener('online', () => { poll(); refreshInstruments(); refreshTracking() })
