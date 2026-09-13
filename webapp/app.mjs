import { SignalKClient, CourseProgressionService } from './api-client.mjs'
import { ChartSourceService, courseBounds, coversBounds } from './chart-sources.mjs'
import { coursePoints, raceProgress } from './course-progress.mjs'
import { LocalChartVerifier } from './map-preparation.mjs'

const $ = id => document.getElementById(id)
const client = new SignalKClient()
const progression = new CourseProgressionService(client)
const charts = new ChartSourceService(client)
const verifier = new LocalChartVerifier()
const L = window.L
const map = L.map('map', { zoomControl: true }).setView([0, 0], 2)
const routeLayer = L.layerGroup().addTo(map)
const vesselLayer = L.layerGroup().addTo(map)
const trackLine = L.polyline([], { color: '#526671', weight: 2, opacity: 0.65 }).addTo(map)
let track = [], status = null, progress = null, sources = [], selectedChart = null, tileLayer = null
let lastCourseKey = '', lastChartsAt = 0, busy = false, polling = false, selectedPointDirty = false
const notice = message => { $('notice').textContent = message || '' }
const metric = (id, number, suffix, decimals = 1) => { $(id).textContent = number === null ? '—' : `${number.toFixed(decimals)}${suffix}` }
const safeText = text => { const node = document.createElement('span'); node.textContent = text; return node }

function fitCourse() {
  const points = progress?.points || []
  if (points.length) map.fitBounds(points.map(point => [point.latitude, point.longitude]), { padding: [35, 55], maxZoom: 15 })
  else if (progress?.position) map.setView([progress.position.latitude, progress.position.longitude], 13)
}

function renderCourse() {
  const course = status.desired?.action === 'clear' ? status.desired : status.cachedCourse || status.desired
  $('course-name').textContent = course?.action !== 'clear' && course?.name ? course.name : 'Onboard navigation'
  $('cloud-state').textContent = status.uploadMode === 'local_only' ? 'Uploads paused' : status.connectionState === 'online' ? 'Cloud connected' : 'Cloud offline / unconfirmed'
  const ack = status.acknowledgement
  $('active-status').textContent = progress.matches ? `Wake Logger course active · Revision ${course?.revision ?? '—'}` : progress.points.length ? `Wake Logger course not currently active${status.native?.course?.activeRoute?.name ? ` · Signal K: ${status.native.course.activeRoute.name}` : ''}` : 'No course selected in Wake Logger'
  if (ack?.status === 'rejected') $('active-status').textContent += ' · Update rejected; last usable course retained'
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
    if (!track.length || track.at(-1)[0] !== point[0] || track.at(-1)[1] !== point[1]) track.push(point)
    if (track.length > 2000) track = track.slice(-2000)
    trackLine.setLatLngs(track)
  }
  $('centre-vessel').disabled = !progress.position
  if (courseChanged) { fitCourse(); lastCourseKey = key; renderChartReadiness(); reportMap('unknown') }
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

async function poll() {
  if (polling) return
  polling = true
  try {
    const [nextStatus, navigation, calculated] = await Promise.all([
      client.request('/plugins/signalk-wakelogger/course'),
      client.request('/signalk/v1/api/vessels/self/navigation').catch(() => ({})),
      client.request('/signalk/v2/api/vessels/self/navigation/course/calcValues').catch(() => ({})),
    ])
    status = nextStatus
    const nativeRoute = status.native?.ownedRouteId
      ? await client.request(`/signalk/v2/api/resources/routes/${encodeURIComponent(status.native.ownedRouteId)}`).catch(() => null)
      : null
    progress = raceProgress(status, navigation, calculated, nativeRoute)
    $('login').hidden = true
    renderCourse()
    if (Date.now() - lastChartsAt > 60_000) await discoverCharts()
  } catch (error) {
    if ([401, 403].includes(error.status)) $('login').hidden = false
    notice(error.message)
    $('cloud-state').textContent = 'Signal K unavailable'
  } finally { polling = false }
}

async function command(action) {
  if (busy) return
  busy = true
  try { await action(); selectedPointDirty = false; notice('Navigation updated.'); await poll() }
  catch (error) { notice(error.message) }
  finally { busy = false; if (progress) renderCourse() }
}

$('fit-course').onclick = fitCourse
$('centre-vessel').onclick = () => { if (progress?.position) map.setView([progress.position.latitude, progress.position.longitude], Math.max(12, map.getZoom())) }
$('activate-course').onclick = () => command(() => progression.activate())
$('advance-point').onclick = () => command(() => progression.advance(status.native.course.activeRoute.href))
$('point-index').onchange = () => { selectedPointDirty = true }
$('set-point').onclick = () => command(() => progression.setPoint(Number($('point-index').value), progress.points.length, status.native.course.activeRoute.href))
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
  return client.request('/plugins/signalk-wakelogger/course/map-readiness', { method: 'POST', body: JSON.stringify({ revision, status: mapStatus }) }).catch(() => {})
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
    if (!entries.length) $('cache-status').textContent = 'No chart preparation jobs. Prepare licensed maps in Signal K Charts; verify local coverage before departure.'
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

await poll()
setInterval(() => { if (!document.hidden) poll() }, 3000)
window.addEventListener('online', () => poll())
