export interface SailingAverageSample {
  at: number
  twsKnots?: number | null
  twdDeg?: number | null
  headingDeg?: number | null
  sogKnots?: number | null
}

export interface SailingAverages {
  twsKnots: number | null
  twdDeg: number | null
  headingDeg: number | null
  sogKnots: number | null
  sampleCount: number
  windowSeconds: number
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000

export class RollingAverages {
  private samples: SailingAverageSample[] = []
  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  add(sample: SailingAverageSample): void {
    if (!Number.isFinite(sample.at)) return
    this.samples.push(sample)
    this.prune(sample.at)
  }

  value(now: number): SailingAverages | null {
    this.prune(now)
    if (!this.samples.length) return null
    const tws = average(this.samples.map((sample) => sample.twsKnots))
    const sog = average(this.samples.map((sample) => sample.sogKnots))
    const heading = circularAverage(this.samples.map((sample) => sample.headingDeg))
    const twd = circularAverage(this.samples.map((sample) => sample.twdDeg))
    return {
      twsKnots: tws,
      twdDeg: twd,
      headingDeg: heading,
      sogKnots: sog,
      sampleCount: this.samples.length,
      windowSeconds: Math.round(this.windowMs / 1000)
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    while (this.samples.length && this.samples[0]!.at < cutoff) this.samples.shift()
  }
}

function average(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!numbers.length) return null
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
}

function circularAverage(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!numbers.length) return null
  let x = 0
  let y = 0
  for (const value of numbers) {
    const radians = value * Math.PI / 180
    x += Math.cos(radians)
    y += Math.sin(radians)
  }
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return null
  return ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360
}