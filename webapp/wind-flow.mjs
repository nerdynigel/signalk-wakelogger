// FigCraft wind-flow note: this is a screen-space weather illustration, never
// navigation guidance. The source clock controls freshness independently of RAF.
import { guidanceWind } from './wind-readout.mjs'
const finite = Number.isFinite
const radians = degrees => degrees * Math.PI / 180
const norm = angle => (angle % 360 + 360) % 360
const delta = (from, to) => (to - from + 540) % 360 - 180
export function windFlowReading(view, snapshot, now = Date.now()) {
  const published = guidanceWind(snapshot, now)
  if (published) return finite(published.twdDeg) && finite(published.twsKn) ? { from: published.twdDeg, speed: published.twsKn, at: published.at } : null
  const { speed, direction } = view.displayWind || {}
  return speed?.available && direction?.available && finite(speed.timestamp) && finite(direction.timestamp)
    ? { from: direction.value, speed: speed.value, at: Math.min(speed.timestamp, direction.timestamp) } : null
}
export function windFlowStyle(speed) {
  const bands = [[2, 12, .30, 1.2, 8], [8, 18, .45, 1.4, 16], [16, 24, .60, 1.7, 26], [25, 30, .75, 2.1, 36]]
  const upper = Math.max(1, bands.findIndex(band => speed < band[0]))
  const a = speed >= 25 ? bands[3] : bands[upper - 1], b = speed >= 25 ? a : bands[upper]
  const t = a === b ? 0 : Math.max(0, Math.min(1, (speed - a[0]) / (b[0] - a[0])))
  const values = a.slice(1).map((value, i) => value + (b[i + 1] - value) * t)
  return { length: values[0], opacity: values[1], weight: values[2], drift: values[3] }
}
export class WindFlowModel {
  samples = []
  update(reading, now = Date.now()) {
    if (!reading || ![reading.from, reading.speed, reading.at].every(finite) || reading.speed < 0 || reading.at > now + 1000 || now - reading.at > 10000) return
    const last = this.samples.at(-1)
    if (last && reading.at <= last.at) return // a repeated poll is not a fresh sensor sample
    const current = this.sample(now)
    this.samples = this.samples.filter(sample => sample.at >= reading.at - 10000)
    this.samples.push({ ...reading, from: norm(reading.from) })
    const x = this.samples.reduce((sum, sample) => sum + Math.sin(radians(sample.from)), 0)
    const y = this.samples.reduce((sum, sample) => sum + Math.cos(radians(sample.from)), 0)
    this.target = { from: Math.hypot(x, y) < .001 ? current?.from ?? reading.from : norm(Math.atan2(x, y) * 180 / Math.PI), speed: this.samples.reduce((sum, sample) => sum + sample.speed, 0) / this.samples.length }
    this.origin = current || this.target
    this.changedAt = now
  }
  sample(now = Date.now(), reduced = false) {
    const last = this.samples.at(-1)
    if (!last || now - last.at >= 30000) return null
    const age = Math.max(0, now - last.at), stale = age > 10000
    const t = reduced ? 1 : Math.max(0, Math.min(1, (Math.min(now, last.at + 10000) - this.changedAt) / 900))
    const from = norm(this.origin.from + delta(this.origin.from, this.target.from) * t)
    const speed = this.origin.speed + (this.target.speed - this.origin.speed) * t
    return { from, to: norm(from + 180), speed, stale, calm: speed < 2, ...windFlowStyle(speed), ...(stale ? { opacity: .15 } : {}) }
  }
}
const random = seed => { const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n) }
export function windFlowGrid(width, height, phone = false) {
  const spacing = phone ? 100 : 150, cols = Math.max(1, Math.floor(width / spacing)), rows = Math.max(1, Math.floor(height / spacing))
  return Array.from({ length: cols * rows }, (_, id) => ({ id, x: (id % cols + .5) * width / cols, y: (Math.floor(id / cols) + .5) * height / rows, spacing, phase: random(id + 1) * 4000 }))
}
export function windFlowArrow(cell, wind, elapsed, reduced = false) {
  const time = reduced ? cell.phase : elapsed + cell.phase, cycle = Math.floor(time / 4000), age = time % 4000
  const dx = Math.sin(radians(wind.to)), dy = -Math.cos(radians(wind.to))
  const travel = reduced ? 0 : (age / 1000 - 2) * wind.drift
  const seed = cell.id * 97 + cycle * 13
  const fade = reduced ? 1 : Math.min(1, age / 600, (4000 - age) / 600)
  return { x: cell.x + (random(seed + 7) - .5) * cell.spacing * .6 + dx * travel, y: cell.y + (random(seed + 11) - .5) * cell.spacing * .6 + dy * travel, opacity: wind.opacity * fade }
}
export class WindFlowLayer {
  constructor(container, reducedMotion, host = container) {
    this.container = container; this.reducedMotion = reducedMotion; this.model = new WindFlowModel(); this.elapsed = 0; this.visible = true
    this.canvas = document.createElement('canvas'); this.canvas.className = 'wind-flow-layer'; this.canvas.setAttribute('aria-hidden', 'true')
    this.calm = document.createElement('span'); this.calm.className = 'wind-calm'; this.calm.textContent = 'Calm'; this.calm.hidden = true
    host.append(this.canvas, this.calm)
    this.context = this.canvas.getContext('2d')
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(container)
    reducedMotion.addEventListener('change', () => this.wake())
    document.addEventListener('visibilitychange', () => this.wake())
    this.resize()
  }
  resize() {
    const width = this.container.clientWidth, height = this.container.clientHeight
    if (width !== this.width || height !== this.height) {
      this.width = width; this.height = height
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      this.canvas.style.width = width + 'px'; this.canvas.style.height = height + 'px'
      this.canvas.width = width * ratio; this.canvas.height = height * ratio; this.context.setTransform(ratio, 0, 0, ratio, 0, 0)
      this.cells = windFlowGrid(width, height, window.innerWidth <= 760)
    }
    this.setOrigin(this.origin || { x: 0, y: 0 })
    this.wake()
  }
  setOrigin(point) { this.origin = point; this.canvas.style.transform = 'translate(' + point.x + 'px,' + point.y + 'px)'; this.calm.style.left = point.x + 16 + 'px'; this.calm.style.top = point.y + 116 + 'px' }
  update(reading) { this.model.update(reading); this.wake() }
  setVisible(visible) { this.visible = visible; this.wake() }
  wake() {
    cancelAnimationFrame(this.frame); clearTimeout(this.timer); this.previous = null
    if (this.visible && !document.hidden && this.width && this.height) this.paint()
  }
  paint = () => {
    const now = Date.now(), reduced = this.reducedMotion.matches, wind = this.model.sample(now, reduced)
    if (wind && !wind.stale && !reduced && this.previous) this.elapsed += Math.min(100, now - this.previous)
    this.previous = now
    const context = this.context; context.clearRect(0, 0, this.width, this.height)
    this.calm.hidden = !wind?.calm; this.calm.style.opacity = wind?.stale ? '.15' : '1'
    this.canvas.dataset.state = !wind ? 'unavailable' : wind.stale ? 'stale' : wind.calm ? 'calm' : 'fresh'
    this.canvas.dataset.direction = wind ? String(wind.to) : ''; this.canvas.dataset.arrowCount = String(wind && !wind.calm ? this.cells.length : 0)
    this.canvas.dataset.motion = reduced ? 'reduced' : wind?.stale ? 'stopped' : 'animated'; this.canvas.dataset.elapsed = String(this.elapsed)
    if (wind && !wind.calm) for (const cell of this.cells) {
      const arrow = windFlowArrow(cell, wind, this.elapsed, reduced)
      context.save(); context.translate(arrow.x, arrow.y); context.rotate(radians(wind.to)); context.globalAlpha = arrow.opacity
      context.strokeStyle = '#fff'; context.lineWidth = wind.weight; context.lineCap = 'round'
      context.beginPath(); context.moveTo(0, wind.length / 2); context.lineTo(0, -wind.length / 2); context.moveTo(-3, -wind.length / 2 + 4); context.lineTo(0, -wind.length / 2); context.lineTo(3, -wind.length / 2 + 4); context.stroke(); context.restore()
    }
    if (!wind) return
    if (!reduced && !wind.stale && !wind.calm) this.frame = requestAnimationFrame(this.paint)
    else this.timer = setTimeout(this.paint, 1000)
  }
}
