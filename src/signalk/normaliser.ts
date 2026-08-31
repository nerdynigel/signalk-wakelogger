import type { Delta } from '@signalk/server-api'
import type { TelemetryDraft, TelemetryField, TelemetryQuality, TelemetryValues } from '../telemetry/types'
import type { SignalKPath } from './paths'

const MS_PER_SECOND = 1000
const MPS_TO_KNOTS = 1.9438444924406
const EARLIEST_SOURCE_TIME = Date.UTC(2000, 0, 1)
const MAX_FUTURE_MS = 5 * 60 * MS_PER_SECOND

interface PositionValue { latitude: number; longitude: number }
interface TimedValue<T> { value: T; sourceAt?: number; receivedAt: number }

export class TelemetryNormaliser {
  private readonly values = new Map<SignalKPath, TimedValue<unknown>>()
  private dirty = false
  private readonly emitted = new Set<Exclude<TelemetryField, 'position'>>()

  ingest(delta: Delta, receivedAt = Date.now()): void {
    for (const update of delta.updates) {
      if (!('values' in update)) continue
      const sourceAt = parseSourceTime(update.timestamp as string | undefined, receivedAt)
      for (const pathValue of update.values) {
        if (!isSupportedPath(pathValue.path as string)) continue
        if (pathValue.state?.timedOut || !isValidPathValue(pathValue.path as SignalKPath, pathValue.value)) {
          if (this.values.delete(pathValue.path as SignalKPath)) this.dirty = true
          continue
        }
        this.values.set(pathValue.path as SignalKPath, { value: pathValue.value, sourceAt, receivedAt })
        this.dirty = true
      }
    }
  }

  takeSample(now = Date.now(), fields: Set<TelemetryField> = new Set(['position', 'sog', 'cog', 'heading', 'depth', 'apparentWind'])): TelemetryDraft | undefined {
    if (!this.dirty) return undefined
    const position = this.get<PositionValue>('navigation.position', now)
    if (!position) return undefined
    this.dirty = false

    const headingTrue = fields.has('heading') ? this.get<number>('navigation.headingTrue', now) : undefined
    const headingMagnetic = fields.has('heading') ? this.get<number>('navigation.headingMagnetic', now) : undefined
    const capturedAt = position.sourceAt ?? now
    const quality: TelemetryQuality = { timestamp: position.sourceAt !== undefined ? 'source' : 'receipt' }
    const values: TelemetryValues = {
      lat: position.value.latitude,
      lon: position.value.longitude,
      sog_kn: fields.has('sog') ? convertNumber(this.get<number>('navigation.speedOverGround', now), (v) => v * MPS_TO_KNOTS) : undefined,
      cog_deg: fields.has('cog') ? convertNumber(this.get<number>('navigation.courseOverGroundTrue', now), radiansToDegrees) : undefined,
      heading_deg: convertNumber(headingTrue ?? headingMagnetic, radiansToDegrees),
      heading_reference: headingTrue !== undefined ? 'true' : headingMagnetic !== undefined ? 'magnetic' : undefined,
      depth_m: fields.has('depth') ? this.get<number>('environment.depth.belowTransducer', now)?.value : undefined,
      aws_kn: fields.has('apparentWind') ? convertNumber(this.get<number>('environment.wind.speedApparent', now), (v) => v * MPS_TO_KNOTS) : undefined,
      awa_deg: fields.has('apparentWind') ? convertNumber(this.get<number>('environment.wind.angleApparent', now), radiansToDegrees) : undefined
    }
    const cleared: Exclude<TelemetryField, 'position'>[] = []
    this.trackPresence('sog', fields.has('sog'), values.sog_kn !== undefined, cleared)
    this.trackPresence('cog', fields.has('cog'), values.cog_deg !== undefined, cleared)
    this.trackPresence('heading', fields.has('heading'), values.heading_deg !== undefined, cleared)
    this.trackPresence('depth', fields.has('depth'), values.depth_m !== undefined, cleared)
    this.trackPresence('apparentWind', fields.has('apparentWind'), values.aws_kn !== undefined || values.awa_deg !== undefined, cleared)
    removeUndefined(values as unknown as Record<string, unknown>)
    return { capturedAt, receivedAt: now, values, quality, cleared: cleared.length ? cleared : undefined }
  }

  private get<T>(path: SignalKPath, now: number): TimedValue<T> | undefined {
    const value = this.values.get(path) as TimedValue<T> | undefined
    return value && now - value.receivedAt <= 30_000 ? value : undefined
  }

  private trackPresence(field: Exclude<TelemetryField, 'position'>, due: boolean, present: boolean, cleared: Exclude<TelemetryField, 'position'>[]): void {
    if (!due) return
    if (present) this.emitted.add(field)
    else if (this.emitted.delete(field)) cleared.push(field)
  }
}

function parseSourceTime(value: string | undefined, receivedAt: number): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= EARLIEST_SOURCE_TIME && parsed <= receivedAt + MAX_FUTURE_MS ? parsed : undefined
}

function isSupportedPath(path: string): path is SignalKPath {
  return [
    'navigation.position', 'navigation.speedOverGround', 'navigation.courseOverGroundTrue',
    'navigation.headingTrue', 'navigation.headingMagnetic', 'environment.depth.belowTransducer',
    'environment.wind.speedApparent', 'environment.wind.angleApparent'
  ].includes(path)
}

function isValidPathValue(path: SignalKPath, value: unknown): boolean {
  if (path === 'navigation.position') {
    const p = value as Partial<PositionValue> | null
    return !!p && finiteBetween(p.latitude, -90, 90) && finiteBetween(p.longitude, -180, 180)
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  switch (path) {
    case 'navigation.speedOverGround': return finiteBetween(value, 0, 80)
    case 'environment.depth.belowTransducer': return finiteBetween(value, 0, 12_000)
    case 'environment.wind.speedApparent': return finiteBetween(value, 0, 120)
    default: return Math.abs(value) <= Math.PI * 100
  }
}

function finiteBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function radiansToDegrees(value: number): number {
  return ((value * 180 / Math.PI) % 360 + 360) % 360
}

function convertNumber(value: TimedValue<number> | number | undefined, convert: (v: number) => number): number | undefined {
  if (value === undefined) return undefined
  const number = typeof value === 'number' ? value : value.value
  return Math.round(convert(number) * 1_000_000) / 1_000_000
}

function removeUndefined(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
}
