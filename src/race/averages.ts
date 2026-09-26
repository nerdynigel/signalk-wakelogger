export interface SailingAverageSample {
  at: number
  twsKnots?: number | null
  twdDeg?: number | null
  headingDeg?: number | null
  cogDeg?: number | null
  sogKnots?: number | null
  stwKnots?: number | null
  heelDeg?: number | null
  awsKnots?: number | null
  awaDeg?: number | null
  latitude?: number | null
  longitude?: number | null
}

export interface SailingAverages {
  twsKnots: number | null
  twdDeg: number | null
  headingDeg: number | null
  cogDeg: number | null
  sogKnots: number | null
  stwKnots: number | null
  heelDeg: number | null
  awsKnots: number | null
  awaDeg: number | null
  sampleCount: number
  windowSeconds: number
  windSource: 'true' | 'derived' | null
  /** Number of samples carrying a usable wind + navigation reading. */
  qualifyingSampleCount: number
  /** Actual timespan covered by the retained samples. */
  coveredSeconds: number
  /** Age of the newest retained sample at evaluation time. */
  latestSampleAgeSeconds: number | null
}

// Shared observation-readiness contract. Both the cloud ingestion path and the
// onboard collector apply the same thresholds so the current leg switches to
// observed wind at the same point.
export const OBSERVATION_WINDOW_SECONDS = 300
export const OBSERVATION_WINDOW_MS = OBSERVATION_WINDOW_SECONDS * 1000
export const OBSERVATION_MIN_SPAN_SECONDS = 240
export const OBSERVATION_MIN_SAMPLES = 30
export const OBSERVATION_MAX_AGE_SECONDS = 30

const DEFAULT_WINDOW_MS = OBSERVATION_WINDOW_MS

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
    const stw = average(this.samples.map((sample) => sample.stwKnots))
    const heading = circularAverage(this.samples.map((sample) => sample.headingDeg))
    const cog = circularAverage(this.samples.map((sample) => sample.cogDeg))
    const twd = circularAverage(this.samples.map((sample) => sample.twdDeg))
    const heel = average(this.samples.map((sample) => sample.heelDeg))
    const aws = average(this.samples.map((sample) => sample.awsKnots))
    const awa = average(this.samples.map((sample) => sample.awaDeg))
    const qualifying = this.samples.filter(qualifies)
    const firstQualifying = qualifying[0]
    const lastQualifying = qualifying[qualifying.length - 1]
    return {
      twsKnots: tws,
      twdDeg: twd,
      headingDeg: heading,
      cogDeg: cog,
      sogKnots: sog,
      stwKnots: stw,
      heelDeg: heel,
      awsKnots: aws,
      awaDeg: awa,
      sampleCount: this.samples.length,
      windowSeconds: Math.round(this.windowMs / 1000),
      windSource: tws !== null ? 'true' : null,
      qualifyingSampleCount: qualifying.length,
      coveredSeconds: firstQualifying && lastQualifying ? Math.max(0, Math.round((lastQualifying.at - firstQualifying.at) / 1000)) : 0,
      latestSampleAgeSeconds: lastQualifying ? Math.max(0, Math.round((now - lastQualifying.at) / 1000)) : null
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    while (this.samples.length && this.samples[0]!.at < cutoff) this.samples.shift()
  }
}

// A "complete qualifying" sample carries a usable true wind speed/direction and
// a navigation reference (position handled separately). Invalid/stale samples
// are excluded by the collector before they reach the rolling window.
function qualifies(sample: SailingAverageSample): boolean {
  const speed = typeof sample.twsKnots === 'number' && Number.isFinite(sample.twsKnots)
  const direction = typeof sample.twdDeg === 'number' && Number.isFinite(sample.twdDeg)
  const navigation = (typeof sample.sogKnots === 'number' && Number.isFinite(sample.sogKnots))
    || (typeof sample.cogDeg === 'number' && Number.isFinite(sample.cogDeg))
    || (typeof sample.headingDeg === 'number' && Number.isFinite(sample.headingDeg))
  return speed && direction && navigation
}

function average(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!numbers.length) return null
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
}

export function circularAverage(values: Array<number | null | undefined>): number | null {
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
