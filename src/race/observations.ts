import type { Delta } from '@signalk/server-api'
import { normalizeDegrees } from './sailing/physics'
import {
  deriveTrueWindSample,
  OBSERVATION_MAX_AGE_SECONDS,
  OBSERVATION_MIN_SAMPLES,
  OBSERVATION_MIN_SPAN_SECONDS,
  OBSERVATION_WINDOW_MS,
  OBSERVATION_WINDOW_SECONDS,
  observationReadiness,
  type ObservationReadiness,
  type SailingAverageSample,
  type SailingAverages
} from './observation-window'
import { RollingAverages } from './averages'

const MPS_TO_KNOTS = 1.9438444924406
const RADIANS_TO_DEGREES = 180 / Math.PI
const STALE_MS = 30_000
const MIN_SAMPLE_INTERVAL_MS = 5_000
const MAX_SAMPLES_PER_DELTA = 32

// Shared with the cloud ingestion path: a current leg is only planned from
// observations once the rolling window covers a genuine five-minute interval,
// not merely a burst of samples.
export { OBSERVATION_WINDOW_SECONDS, OBSERVATION_MIN_SPAN_SECONDS, OBSERVATION_MIN_SAMPLES, OBSERVATION_MAX_AGE_SECONDS, observationReadiness }
export type { ObservationReadiness, SailingAverageSample, SailingAverages }

export function observationsSufficient(averages: SailingAverages | null | undefined, position: { latitude: number; longitude: number } | null = null): boolean {
  return observationReadiness(averages, position).ready
}

// Paths the onboard planner reads locally. These are separate from the cloud
// telemetry protocol: the plugin does not widen what it transmits.
export const OBSERVATION_PATHS = [
  'navigation.position',
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue',
  'navigation.courseOverGroundMagnetic',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'navigation.speedThroughWater',
  'navigation.attitude',
  'environment.wind.speedTrue',
  'environment.wind.directionTrue',
  'environment.wind.speedApparent',
  'environment.wind.angleApparent',
  'environment.wind.directionApparent'
] as const

export type ObservationPath = (typeof OBSERVATION_PATHS)[number]

interface TimedValue { value: unknown; receivedAt: number }

export interface VesselObservation {
  latitude: number
  longitude: number
  capturedAt: number
}

export interface SailingObservations {
  averages: SailingAverages
  position: VesselObservation | null
  lastUpdateAt: number | null
  readiness: ObservationReadiness
}

export interface DerivedTrueWind {
  twsKnots: number
  twdDeg: number
  reference: 'true' | 'derived'
}

function pathIsObservation(path: string): path is ObservationPath {
  return (OBSERVATION_PATHS as readonly string[]).includes(path)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function inRange(value: unknown, min: number, max: number): value is number {
  return finite(value) && value >= min && value <= max
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function toKnots(value: number): number {
  return Math.round(value * MPS_TO_KNOTS * 1_000_000) / 1_000_000
}

function toDegrees(value: number): number {
  return Math.round(normalizeDegrees(value * RADIANS_TO_DEGREES) * 1_000_000) / 1_000_000
}

function toSignedDegrees(value: number): number {
  const degrees = ((value * RADIANS_TO_DEGREES + 540) % 360) - 180
  return Math.round(degrees * 1_000_000) / 1_000_000
}

interface PositionValue { latitude: number; longitude: number }
interface AttitudeValue { roll?: number; pitch?: number; yaw?: number }

// Backward-compatible wrapper around the shared per-sample derivation. The
// single-sample convenience API rounds for display; the aggregation path uses
// the unrounded `deriveTrueWindSample` so both engines aggregate identical
// values.
export function deriveTrueWind(options: {
  headingDeg?: number | null
  courseDeg?: number | null
  sogKnots?: number | null
  stwKnots?: number | null
  awaDeg?: number | null
  apparentDirectionDeg?: number | null
  awsKnots?: number | null
}): DerivedTrueWind | null {
  const derived = deriveTrueWindSample({
    twsKnots: null,
    twdDeg: null,
    headingDeg: options.headingDeg ?? null,
    cogDeg: options.courseDeg ?? null,
    sogKnots: options.sogKnots ?? null,
    awsKnots: options.awsKnots ?? null,
    awaDeg: options.awaDeg ?? null,
    apparentDirectionDeg: options.apparentDirectionDeg ?? null
  })
  if (!derived) return null
  return { twsKnots: round(derived.twsKnots, 2), twdDeg: round(derived.twdDeg, 1), reference: derived.direct ? 'true' : 'derived' }
}

export class ObservationCollector {
  private readonly values = new Map<ObservationPath, TimedValue>()
  private readonly rolling: RollingAverages
  private readonly windowMs: number
  private lastSampleAt = 0
  private lastUpdateAt: number | null = null

  constructor(windowMs = OBSERVATION_WINDOW_MS, private readonly now: () => number = Date.now) {
    this.windowMs = windowMs
    this.rolling = new RollingAverages(windowMs)
  }

  ingest(delta: Delta, receivedAt = this.now()): void {
    if (!delta || !Array.isArray(delta.updates)) return
    let changed = false
    for (const update of delta.updates) {
      if (!('values' in update)) continue
      let considered = 0
      for (const pathValue of update.values) {
        if (considered >= MAX_SAMPLES_PER_DELTA) break
        considered += 1
        const path = pathValue.path as string
        if (!pathIsObservation(path)) continue
        if (pathValue.state?.timedOut || !this.valid(path, pathValue.value)) {
          if (this.values.delete(path)) changed = true
          continue
        }
        this.values.set(path, { value: pathValue.value, receivedAt })
        changed = true
      }
    }
    if (changed) {
      this.lastUpdateAt = receivedAt
      this.capture(receivedAt)
    }
  }

  observations(now = this.now()): SailingObservations {
    const averages = this.rolling.value(now) ?? emptyAverages(Math.round(this.windowMs / 1000))
    const position = this.position(now)
    return { averages, position, lastUpdateAt: this.lastUpdateAt, readiness: observationReadiness(averages, position) }
  }

  position(now = this.now()): VesselObservation | null {
    const position = this.get<PositionValue>('navigation.position', now)
    if (!position) return null
    return { latitude: position.value.latitude, longitude: position.value.longitude, capturedAt: position.receivedAt }
  }

  private capture(at: number): void {
    if (at - this.lastSampleAt < MIN_SAMPLE_INTERVAL_MS && this.rolling.value(at)) return
    this.lastSampleAt = at
    const sample: SailingAverageSample = {
      at,
      headingDeg: this.angle('navigation.headingTrue') ?? this.angle('navigation.headingMagnetic'),
      cogDeg: this.angle('navigation.courseOverGroundTrue') ?? this.angle('navigation.courseOverGroundMagnetic'),
      sogKnots: this.speed('navigation.speedOverGround'),
      stwKnots: this.speed('navigation.speedThroughWater'),
      heelDeg: this.heel(),
      twsKnots: this.speed('environment.wind.speedTrue'),
      twdDeg: this.angle('environment.wind.directionTrue'),
      gustKnots: null,
      awsKnots: this.speed('environment.wind.speedApparent'),
      awaDeg: this.angle('environment.wind.angleApparent'),
      apparentDirectionDeg: this.angle('environment.wind.directionApparent'),
      latitude: this.get<PositionValue>('navigation.position', at)?.value.latitude ?? null,
      longitude: this.get<PositionValue>('navigation.position', at)?.value.longitude ?? null
    }
    this.rolling.add(sample)
  }

  private valid(path: ObservationPath, value: unknown): boolean {
    if (path === 'navigation.position') {
      const position = value as Partial<PositionValue> | null
      return !!position && inRange(position.latitude, -90, 90) && inRange(position.longitude, -180, 180)
    }
    if (path === 'navigation.attitude') {
      const attitude = value as AttitudeValue | null
      return !!attitude && finite(attitude.roll) && Math.abs(attitude.roll) <= Math.PI * 2
    }
    if (!finite(value)) return false
    switch (path) {
      case 'navigation.speedOverGround':
      case 'navigation.speedThroughWater': return value >= 0 && value <= 80
      case 'environment.wind.speedTrue':
      case 'environment.wind.speedApparent': return value >= 0 && value <= 120
      case 'environment.wind.angleApparent': return Math.abs(value) <= Math.PI * 4
      default: return Math.abs(value) <= Math.PI * 100
    }
  }

  private get<T>(path: ObservationPath, now: number): TimedValue & { value: T } | undefined {
    const value = this.values.get(path)
    if (!value || now - value.receivedAt > STALE_MS) return undefined
    return value as TimedValue & { value: T }
  }

  private speed(path: ObservationPath): number | null {
    const value = this.get<number>(path, this.now())
    return value ? toKnots(value.value) : null
  }

  private angle(path: ObservationPath): number | null {
    const value = this.get<number>(path, this.now())
    if (!value) return null
    if (path === 'environment.wind.angleApparent') return toSignedDegrees(value.value)
    return toDegrees(value.value)
  }

  private heel(): number | null {
    const attitude = this.get<AttitudeValue>('navigation.attitude', this.now())
    if (!attitude || !finite(attitude.value?.roll)) return null
    return Math.round(attitude.value.roll * RADIANS_TO_DEGREES * 10) / 10
  }
}

function emptyAverages(windowSeconds: number): SailingAverages {
  return {
    twsKnots: null, twdDeg: null, gustKnots: null, headingDeg: null, cogDeg: null, sogKnots: null,
    stwKnots: null, heelDeg: null, awsKnots: null, awaDeg: null,
    sampleCount: 0, windowSeconds, windSource: null,
    qualifyingSampleCount: 0, coveredSeconds: 0, latestSampleAgeSeconds: null
  }
}

// Re-exported so consumers that imported these from `observations` keep working.
export { aggregateObservationSamples } from './observation-window'
