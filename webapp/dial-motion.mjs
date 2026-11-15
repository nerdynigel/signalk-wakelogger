// Presentation-only interpolation: measured values and their source clocks are
// unchanged. Never extrapolate or animate a reading after it becomes unavailable.
const keys = ['heading', 'awa', 'twa', 'cog', 'btw']
const finite = value => typeof value === 'number' && Number.isFinite(value)
export const shortestAngle = (from, to) => ((to - from + 540) % 360 + 360) % 360 - 180
export class DialMotion {
  constructor(duration = 900) {
    this.duration = duration
    this.from = Object.fromEntries(keys.map(key => [key, null]))
    this.to = { ...this.from }
    this.startedAt = 0
    this.animate = false
    this.reference = null
  }
  sample(now) {
    const t = this.animate ? Math.min(1, Math.max(0, (now - this.startedAt) / this.duration)) : 1
    return Object.fromEntries(keys.map(key => [key, !finite(this.to[key]) ? null : !finite(this.from[key]) ? this.to[key] : this.from[key] + (this.to[key] - this.from[key]) * t]))
  }
  update(target, now, { animate = true, reference = null } = {}) {
    const current = this.sample(now)
    const reset = reference !== this.reference
    this.reference = reference
    this.animate = animate && !reset
    this.startedAt = now
    for (const key of keys) {
      const next = finite(target[key]) ? target[key] : null
      const start = finite(current[key]) && this.animate ? current[key] : next
      this.from[key] = start
      this.to[key] = next === null ? null : start === null ? next : start + shortestAngle(start, next)
    }
  }
  moving(now) {
    return this.animate && now < this.startedAt + this.duration && keys.some(key => finite(this.to[key]) && finite(this.from[key]) && Math.abs(this.to[key] - this.from[key]) > 0.001)
  }
}
