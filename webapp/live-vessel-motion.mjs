const finite = Number.isFinite
const wrap = degrees => ((degrees + 180) % 360 + 360) % 360 - 180
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const distance = (a, b) => {
  const rad = Math.PI / 180
  const y = (b.latitude - a.latitude) * rad, x = wrap(b.longitude - a.longitude) * rad
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(Math.sin(y / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(x / 2) ** 2)))
}

/** Display-only interpolation. Never extrapolates or changes recorded fixes. */
export class LiveVesselMotion {
  reset() { this.context = null; this.target = null; this.from = null; this.started = 0; this.duration = 0; this.fixCount = 0; this.followHeadingDeg = null }
  constructor() { this.reset() }
  update(context, fix, now, immediate = false) {
    if (this.context !== context) { this.reset(); this.context = context }
    if (immediate) this.duration = 0
    const at = Date.parse(fix?.capturedAt || '')
    if (!finite(now) || !finite(at) || at > now + 1000 || now - at > 30000
      || !finite(fix?.latitude) || Math.abs(fix.latitude) > 90 || !finite(fix.longitude) || Math.abs(fix.longitude) > 180) return false
    if (this.target && (at <= this.target.at || finite(fix.sequence) && finite(this.target.sequence) && fix.sequence <= this.target.sequence)) return false
    const next = { latitude: fix.latitude, longitude: fix.longitude, headingDeg: finite(fix.headingDeg) ? fix.headingDeg : null, at, sequence: fix.sequence }
    const previous = this.target
    const gap = previous ? (at - previous.at) / 1000 : 0
    // A reconnect starts at its new fix. Within a continuous stream, reject
    // impossible jumps with a generous 80-knot bound plus 20 m GPS allowance.
    if (previous && gap <= 15 && distance(previous, next) > gap * 80 * 0.514444 + 20) return false
    this.fixCount = !previous || gap > 15 ? 1 : this.fixCount + 1
    const course = finite(fix.courseDeg) ? fix.courseDeg : next.headingDeg
    if (!previous || gap > 15 || !finite(this.followHeadingDeg)) this.followHeadingDeg = course
    else if (finite(course)) {
      const turn = wrap(course - this.followHeadingDeg)
      if (Math.abs(turn) >= 2) {
        const alpha = 1 - Math.exp(-gap / (Math.abs(turn) > 35 ? 1.5 : 4))
        this.followHeadingDeg = (this.followHeadingDeg + turn * alpha + 360) % 360
      }
    }
    next.speedKn = fix.speedKn
    this.from = this.sample(now) || next
    this.target = next
    this.started = now
    this.duration = !previous || gap > 15 || immediate ? 0 : clamp(gap * 1000, 500, 2000)
    return true
  }
  followPose() {
    return this.target ? { ...this.target, ready: this.fixCount >= 3,
      headingDeg: this.fixCount >= 3 && finite(this.followHeadingDeg) ? this.followHeadingDeg : this.target.headingDeg } : null
  }
  moving(now) { return !!this.target && now < this.started + this.duration }
  sample(now) {
    if (!this.target) return null
    const fraction = this.duration > 0 ? clamp((now - this.started) / this.duration, 0, 1) : 1
    const a = this.from, b = this.target
    return { latitude: a.latitude + (b.latitude - a.latitude) * fraction,
      longitude: wrap(a.longitude + wrap(b.longitude - a.longitude) * fraction),
      headingDeg: finite(a.headingDeg) && finite(b.headingDeg) ? (a.headingDeg + wrap(b.headingDeg - a.headingDeg) * fraction + 360) % 360 : b.headingDeg }
  }
}

export function outsideFollowArea(point, desired, width, height) {
  return Math.abs(point.x - desired.x) > clamp(width * 0.12, 24, 80)
    || Math.abs(point.y - desired.y) > clamp(height * 0.12, 24, 80)
}
