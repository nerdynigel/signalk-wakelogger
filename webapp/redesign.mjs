// FigCraft pages 06–08. All numbers come from the existing fresh readings and
// navigation models; display modes never change navigation or upload state.
import { formatReading } from './instruments.mjs'
import { guidanceWind, windAngleText } from './wind-readout.mjs'
import { DialMotion } from './dial-motion.mjs'
const finite = value => typeof value === 'number' && Number.isFinite(value)
const norm = value => ((value % 360) + 360) % 360
const point = (angle, radius, cx = 300, cy = 300) => `${(cx + Math.sin(angle * Math.PI / 180) * radius).toFixed(2)},${(cy - Math.cos(angle * Math.PI / 180) * radius).toFixed(2)}`
const node = (tag, className, text) => { const n = document.createElement(tag); n.className = className; if (text != null) n.textContent = text; return n }
// Keep direction suffixes as semantic text, separately sized on mobile.
export function displayValue(element, formatted) {
  const text = String(formatted ?? '—')
  const parts = /^(.*)( (?:PT|STB|NM|kn|°T))$/.exec(text)
  if (parts) { const suffix = node('small', / (PT|STB)$/.test(parts[2]) ? 'side-suffix' : 'unit', parts[2]); if (suffix.className === 'side-suffix') suffix.dataset.side = parts[2].trim(); element.append(document.createTextNode(parts[1]), suffix) }
  else element.textContent = text
  return element
}
export const STATUS_ICONS = {
  signal: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 6a15 15 0 0 0 0 20M22 6a15 15 0 0 1 0 20M13 10a9 9 0 0 0 0 12M19 10a9 9 0 0 1 0 12M16 18v10"/><circle cx="16" cy="15" r="2"/></svg>',
  cloud: '<svg viewBox="-1 -5 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18C2.7 18 0 15.6 0 12.6C0 9.9 2.1 7.7 4.9 7.3C5.6 3.1 9.1 0 13.4 0C17.1 0 20.3 2.4 21.3 5.8C24 6.5 26 8.9 26 11.8C26 15.2 23.3 18 19.9 18L6 18Z"/><path d="M9 9.8L12 12.8L17.6 7.2"/></svg>',
  cloudUpload: '<svg viewBox="-1 -5 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18C2.7 18 0 15.6 0 12.6C0 9.9 2.1 7.7 4.9 7.3C5.6 3.1 9.1 0 13.4 0C17.1 0 20.3 2.4 21.3 5.8C24 6.5 26 8.9 26 11.8C26 15.2 23.3 18 19.9 18L6 18Z"/><path d="M13 13V5M9 9L13 5L17 9"/></svg>',
  vessel: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 23h26l-5 6H9Zm13-3V3L5 20Zm3 0V6l9 14Z"/></svg>'
}
export function statusPresentation(tracking, connected) {
  const local = tracking?.uploadMode === 'local_only'
  const error = !tracking || tracking.paired !== true || tracking.available === false || tracking.recording === false || tracking.recordingError || tracking.persistenceError || tracking.connectionState === 'device_revoked'
  const queue = tracking?.queue?.messageCount
  const cloudHealthy = !error && (local || tracking.connectionState === 'online')
  const cloudState = error ? 'red' : local ? 'green' : !cloudHealthy || !Number.isFinite(queue) || queue > 0 ? 'amber' : 'green'
  return {
    local, icon: local ? 'vessel' : 'cloud',
    signalState: connected === true ? 'green' : connected === false ? 'red' : 'amber',
    signalText: connected === true ? 'Connected — live data' : connected === false ? 'Signal K disconnected' : 'Connecting to Signal K',
    cloudState, cloudText: error ? tracking?.recordingError ? 'Recording paused' : tracking?.persistenceError ? 'Setting not saved' : 'Recorder unavailable' : local ? 'Logging locally' : !cloudHealthy ? 'Waiting for internet' : !Number.isFinite(queue) ? 'Checking uploads' : queue > 0 ? 'Syncing saved history' : 'Synced (up to date)'
  }
}
const dialControllers = new WeakMap()
function createDial() {
  const element = node('div', 'hero-dial')
  element.setAttribute('role', 'img')
  const face = '<circle cx="300" cy="300" r="280" fill="#0d141c" stroke="#29343f" stroke-width="2"/><circle cx="300" cy="300" r="210" fill="#080c11" stroke="#1b242e"/>'
  let ticks = '', labels = '', ring = ''
  for (let i = 0; i < 360; i += 5) {
    ticks += `<polyline points="${point(i, i % 30 === 0 ? 257 : i % 10 === 0 ? 266 : 273)} ${point(i, 278)}" stroke="${i % 30 === 0 ? '#9eacba' : '#52616f'}" stroke-width="${i % 30 === 0 ? 2 : 1}"/>`
    if (i % 30 === 0) labels += `<text data-bearing="${i}" fill="${i === 0 ? '#73e7ff' : '#F6FBFF'}" text-anchor="middle" dominant-baseline="middle" font-size="20" font-weight="500">${({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' })[i] ?? i}</text>`
  }
  for (let i = -150; i <= 180; i += 30) {
    const color = i === 180 ? '#F6FBFF' : i < 0 ? '#e5484d' : '#2fb774'
    ring += `<polyline points="${point(i, 183)} ${point(i, 194)}" stroke="${color}"/><text data-angle="${i}" x="${point(i, 170).split(',')[0]}" y="${point(i, 170).split(',')[1]}" fill="${color}" text-anchor="middle" dominant-baseline="middle" font-size="20" font-weight="500">${Math.abs(i)}</text>`
  }
  const pointer = (kind, color, label) => `<g class="dial-pointer" data-pointer="${kind}"><path d="M300 265V120" stroke="${color}" stroke-width="3"/><g transform="translate(300 104)"><path d="M0 16L-12-12H12Z" fill="${color}" stroke="#080c11"/><text y="3" text-anchor="middle" fill="#080c11" font-size="13" font-weight="700">${label}</text></g></g>`
  // Static numeric SVG geometry. Subsequent samples update only transforms,
  // label positions and visibility, retaining the same SVG and pointer nodes.
  element.innerHTML = `<svg viewBox="0 0 600 600" aria-hidden="true">${face}<g class="compass-card">${ticks}</g><g class="compass-labels">${labels}</g><g class="wind-angle-scale">${ring}</g><path d="M130 200 A198 198 0 0 1 233 113" stroke="#e5484d" stroke-width="9" fill="none"/><path d="M367 113 A198 198 0 0 1 470 200" stroke="#2fb774" stroke-width="9" fill="none"/><path d="M300 235 Q270 280 277 370 L323 370 Q330 280 300 235Z" fill="#111923" stroke="#9eacba" stroke-width="1.5"/><path d="M300 224V120" stroke="#9eacba" stroke-dasharray="4 5"/>${pointer('awa', '#22c3ee', 'A')}${pointer('twa', '#f5a11a', 'T')}<g data-pointer="cog"><path d="M300 255V92" stroke="#f6fbff" stroke-dasharray="4 5"/></g><g data-pointer="btw"><path class="bearing-line" d="M300 220V47" stroke="#ff6fd8" stroke-dasharray="5 5"/><path class="bearing-arrow" d="M300 47L285 22H315Z" fill="#ff6fd8"/></g></svg>`
  const readout = node('div', 'dial-heading')
  readout.append(node('strong', ''))
  element.append(readout)
  const motion = new DialMotion()
  const card = element.querySelector('.compass-card')
  const compassLabels = [...element.querySelectorAll('[data-bearing]')]
  const pointers = Object.fromEntries([...element.querySelectorAll('[data-pointer]')].map(n => [n.dataset.pointer, n]))
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0, lastHeading = 0
  const paint = now => {
    const sample = motion.sample(now)
    if (finite(sample.heading)) lastHeading = sample.heading
    card.setAttribute('transform', `rotate(${-lastHeading} 300 300)`)
    element.dataset.displayHeading = String(norm(lastHeading))
    for (const label of compassLabels) {
      const [x, y] = point(Number(label.dataset.bearing) - lastHeading, 235).split(',')
      label.setAttribute('x', x); label.setAttribute('y', y)
    }
    for (const [key, pointer] of Object.entries(pointers)) {
      pointer.style.display = finite(sample[key]) ? '' : 'none'
      if (finite(sample[key])) pointer.setAttribute('transform', `rotate(${key === 'cog' || key === 'btw' ? sample[key] - lastHeading : sample[key]} 300 300)`)
    }
  }
  const tick = now => {
    frame = 0
    if (!element.isConnected || document.hidden || reducedMotion.matches) {
      paint(motion.startedAt + motion.duration)
      return
    }
    paint(now)
    if (motion.moving(now)) frame = requestAnimationFrame(tick)
  }
  dialControllers.set(element, {
    update(readings, wind, btw) {
      const byId = Object.fromEntries(readings.map(r => [r.id, r]))
      const heading = byId.heading, valid = heading?.available && finite(heading.value)
      const trueRef = valid && heading.reference === 'true'
      element.setAttribute('aria-label', valid ? `Heading ${Math.round(heading.value)} degrees ${heading.reference}` : 'Heading unavailable')
      readout.title = valid ? `Heading · ${heading.reference}` : 'Heading unavailable'
      readout.querySelector('strong').textContent = valid ? `${String(Math.round(norm(heading.value)) % 360).padStart(3, '0')}°` : '—'
      const now = performance.now()
      // A hidden dial settles directly; opening another view never replays old
      // motion. Expired readings are removed on this paint, not after a tween.
      motion.update({ heading: valid ? heading.value : null,
        awa: byId.awa?.available ? byId.awa.value : null,
        twa: wind?.angle?.available ? wind.angle.value : null,
        cog: trueRef && byId.cog?.available ? byId.cog.value : null,
        btw: trueRef && btw?.available ? btw.value : null
      }, now, { animate: !reducedMotion.matches && !document.hidden && element.getClientRects().length > 0, reference: heading?.reference ?? null })
      if (frame) cancelAnimationFrame(frame)
      paint(now)
      frame = motion.moving(now) ? requestAnimationFrame(tick) : 0
    }
  })
  return element
}
export function renderDisplay(grid, view, readings, snapshot, tile, waypoint) {
  const published = guidanceWind(snapshot)
  const wind = published ? { ...view.displayWind, angle: { ...view.displayWind.angle, available: finite(published.twaDeg), value: published.twaDeg }, basis: published.basis } : view.displayWind
  const byId = Object.fromEntries(readings.map(r => [r.id, r]))
  const tileFor = id => {
    const r = byId[id]
    if (id === 'roll') {
      const result = tile({ ...r, label: 'HEEL', value: r.available ? Math.abs(r.value) : r.value })
      if (r.available && r.value !== 0) result.querySelector('.value').append(node('small', 'side-suffix', r.value < 0 ? ' PT' : ' STB'))
      return result
    }
    if (id === 'depth') return tile({ ...r, label: 'DEPTH' })
    return tile(r)
  }
  const card = (id, title) => { const t = tileFor(id); t.dataset.area = id; t.querySelector('.label').textContent = title; return t }
  const sog = card('sog', 'SPEED OVER GROUND'), stw = card('stw', 'SPEED THROUGH WATER')
  const small = ['depth', 'vmg-wind', 'twd', 'roll', 'heading', 'position', 'cog'].map(id => { const t = tileFor(id); t.dataset.area = id; return t })
  const windCard = (id, angleId, title, angle) => {
    const wrapper = node('div', `wind-card ${id}-card`)
    const speed = tileFor(id); speed.querySelector('.label').textContent = title
    wrapper.dataset.windBasis = wind.basis
    speed.title = id === 'tws' ? 'True wind · ' + wind.basis : 'Apparent wind'
    const main = node('div', 'wind-main'); main.append(speed)
    const angleRow = angleId ? tileFor(angleId) : node('div', 'wind-secondary')
    if (!angleId) angleRow.append(node('span', 'label', 'TWA'), displayValue(node('span', 'value'), angle?.available ? windAngleText(angle.value) : '—'))
    if (!angleId) {
      const twd = node('span', 'wind-direction-note')
      twd.append(node('span', 'label', 'TWD'), node('span', 'value', byId.twd?.available ? `${String(Math.round(byId.twd.value)%360).padStart(3,'0')}°` : '—'))
      main.append(twd)
    }
    wrapper.append(main, angleRow)
    return wrapper
  }
  const hero = grid.querySelector('.hero-dial') || createDial()
  hero.dataset.area = 'dial'
  const legend = node('p', 'dial-legend', 'A apparent · T true · inner ring: wind angle · ◆ mark · dashed COG')
  if (hero.parentElement === grid) hero.remove()
  grid.replaceChildren(sog, stw, hero, windCard('aws', 'awa', 'APPARENT WIND'), windCard('tws', null, 'TRUE WIND', wind.angle), ...small, legend)
  dialControllers.get(hero).update(readings, wind, waypoint?.[0])
}
export function windMarkerMarkup(readings, snapshot, now = Date.now()) {
  const byId = Object.fromEntries(readings.map(r => [r.id, r]))
  const heading = byId.heading
  const published = guidanceWind(snapshot, now)
  const direction = byId.twd
  const trueDir = published?.twdDeg ?? (direction?.available ? direction.value : null)
  const trueSpeed = published?.twsKn ?? (byId.tws?.available ? byId.tws.value : null)
  const apparent = heading?.available && heading.reference === 'true' && byId.awa?.available && byId.aws?.available ? { from: norm(heading.value+byId.awa.value), speed: byId.aws.value } : null
  let body = ''
  for (const [kind, from, speed, radius, length, width, color, edge] of [
    ['A', apparent?.from, apparent?.speed, 54, 24, 18, '#22d3ee', '#0f172a'], ['T', trueDir, trueSpeed, 91, 28, 20, '#f59e0b', '#a16207']
  ]) {
    if (!finite(from) || !finite(speed)) continue
    const a = norm(from), [cx, cy] = point(a, radius, 150, 150).split(','), [lx, ly] = point(a, radius+(kind === 'T' ? 32 : 28), 150, 150).split(',')
    body += `<g transform="translate(${cx} ${cy}) rotate(${a+180})"><path d="M0 ${-length*.62+1} L${width/2} ${length*.38+1} L${-width/2} ${length*.38+1}Z" fill="${color}" stroke="${edge}" stroke-width="1.5"/><text y="5" text-anchor="middle" font-size="10" font-weight="900" fill="#111827">${kind}</text></g><text x="${lx}" y="${ly}" text-anchor="middle" font-size="11.2" font-weight="800" fill="${kind === 'T' ? '#d97706' : '#111827'}" stroke="#fff" stroke-width="2.4" paint-order="stroke">${speed.toFixed(1)}</text>`
  }
  return body ? `<svg viewBox="0 0 300 300" width="300" height="300" aria-label="Live wind speed in knots">${body}</svg>` : ''
}
export function renderNavigation(container, { progress, readings, raceView, previewIndex, navigate }) {
  const legs = raceView.remainingLegs || []
  const preview = previewIndex > 0 ? legs[previewIndex] : null
  const title = node('div', 'next-mark-title')
  title.append(node('span', 'eyebrow', preview ? `LEG PREVIEW · PLANNED · ${previewIndex+1} / ${legs.length}` : progress?.next ? `NEXT MARK · ${document.getElementById('point-number').textContent}` : 'NO ACTIVE COURSE'), node('strong', '', preview ? preview.name : progress?.next?.name || 'No next mark'))
  title.append(node('span', 'navigation-note', preview ? preview.summary || 'Sail plan unavailable' : raceView.currentLeg?.summary || 'Sail plan unavailable'))
  const source = preview ? node('span','navigation-note preview-source', `${raceView.historyOnly ? 'Historical plan' : 'Forecast / planned'}${raceView.lastUpdated ? ' · updated '+raceView.lastUpdated : ''}${raceView.stale ? ' · check plan freshness' : ''}`) : null
  const values = node('div', 'navigation-values')
  const byId = Object.fromEntries(readings.map(r => [r.id, r]))
  const format = id => byId[id]?.available ? formatReading(byId[id]) : '—'
  const seconds = progress?.timeToGo
  const hours = finite(seconds) && seconds >= 3600
  const ttg = finite(seconds) ? hours ? `${Math.floor(seconds/3600)}:${String(Math.floor(seconds%3600/60)).padStart(2,'0')}` : `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}` : '—'
  const eta = progress?.eta ? new Date(progress.eta) : null
  const items = preview ? [['AWA', finite(preview.awaDeg) ? `${Math.round(Math.abs(preview.awaDeg))}°${preview.windSide === 'port' ? ' PT' : preview.windSide === 'starboard' ? ' STB' : ''}` : '—'], ['AWS', finite(preview.awsKnots) ? `${preview.awsKnots.toFixed(1)} kn` : '—'], ['TWD', finite(preview.twdDeg) ? `${Math.round(preview.twdDeg)}°` : '—'], ['TWS', finite(preview.twsKnots) ? `${preview.twsKnots.toFixed(1)} kn` : '—']] : [['BTW', format('btw')], ['DTW', format('dtw')], ['TTG', byId.dtw?.available ? ttg : '—'], ['ETA', byId.dtw?.available && eta && finite(eta.getTime()) ? eta.toLocaleTimeString([], { hour:'2-digit',minute:'2-digit',hour12:false }) : '—']]
  for (const [label, value] of items) { const box = node('div', `navigation-value ${label.toLowerCase()}`); box.dataset.reading = label.toLowerCase(); box.dataset.available = String(value !== '—'); const valueNode = node('span', 'value')
    displayValue(valueNode, value)
    box.append(node('span','label',label === 'TTG' ? hours ? 'TTG · H:M' : 'TTG · M:S' : label),valueNode); values.append(box) }
  const actions = node('div','leg-actions')
  if (previewIndex > 0) { const b = node('button','','‹ Previous'); b.onclick = () => navigate(-1); actions.append(b) }
  const next = node('button','','Next leg ›'); next.disabled = previewIndex >= legs.length-1 || !legs.length; next.onclick = () => navigate(1); actions.append(next)

  const focusedAction = container.contains(document.activeElement) ? [...container.querySelectorAll('button')].indexOf(document.activeElement) : -1
  const signature = [title.textContent, values.textContent, actions.textContent, source?.textContent, next.disabled].join('|')
  if (container.dataset.signature === signature) return
  container.dataset.signature = signature
  container.replaceChildren(title,values,actions,...(source ? [source] : []))
  if (focusedAction >= 0) container.querySelectorAll('button')[focusedAction]?.focus({ preventScroll: true })
  container.dataset.preview = String(Boolean(preview))
}
