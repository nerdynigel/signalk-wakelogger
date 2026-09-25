import type { PolarSummary } from './sailing/physics'
import type { SailInventoryItem } from './sailing/selection'

export type PackRounding = 'port' | 'starboard' | 'either'
export type PackPointKind = 'start' | 'mark' | 'gate' | 'finish'
export type PackGateRole = 'port' | 'starboard' | 'either'

// Rule set the plugin understands. A pack advertising any other rule set is
// rejected as `unsupported_rule_set` and never replaces the applied pack.
//
// `race_plan_dynamic_v1` is location-neutral because the identical deterministic
// rules run in two places: the Wake Logger cloud when Live tracking is ON and
// the Signal K vessel when Live tracking is OFF. The cloud implementation must
// implement the identical rules and advertise this exact identifier.
export const RULE_SET_VERSION = 'race_plan_dynamic_v1'
export const SUPPORTED_RULE_SETS = [RULE_SET_VERSION] as const
export type SupportedRuleSet = (typeof SUPPORTED_RULE_SETS)[number]

// Forecast coverage contract. Every leg must carry a real time series so an ETA
// shift can be answered with that leg's own conditions.
export const MIN_FORECAST_SAMPLES_PER_LEG = 2
export const MAX_FORECAST_GAP_MS = 6 * 60 * 60 * 1000
export const MAX_FORECAST_EXTRAPOLATION_MS = 6 * 60 * 60 * 1000

export interface PackLatLon { latitude: number; longitude: number }

export interface PackGate {
  group?: string | null
  role?: PackGateRole | null
}

export interface PackLine {
  port?: PackLatLon | null
  starboard?: PackLatLon | null
}

export interface PackCoursePoint {
  id?: string | null
  name: string
  latitude: number
  longitude: number
  kind?: PackPointKind
  rounding?: PackRounding
  gate?: PackGate | null
  line?: PackLine | null
}

export interface PackForecastSample {
  time: string
  twd_deg: number
  tws_knots: number
  gust_knots?: number | null
  wave_height_m?: number | null
  wave_direction_deg?: number | null
  current_velocity_kn?: number | null
  current_direction_deg?: number | null
}

export interface PackLegForecast {
  sequence: number
  latitude?: number | null
  longitude?: number | null
  samples: PackForecastSample[]
}

export interface PackForecastCoverage {
  from: string
  until: string
}

export interface PackForecast {
  snapshot?: Record<string, unknown> | null
  // Declared window the per-leg series cover. When omitted, validFrom/validUntil
  // are used as the coverage window.
  coverage?: PackForecastCoverage | null
  legs: PackLegForecast[]
}

export interface RacePackRaceHeadsail {
  sail_id: number
  sail_name?: string | null
}

export interface RacePackPayload {
  startTime?: string | null
  availableCrewCount?: number | null
  jibChangesAllowed?: boolean | null
  [key: string]: unknown
}

export interface RacePack {
  v: 1
  kind: 'race_pack'
  packId?: string | null
  revision: number
  racePlanId?: number | null
  generatedAt: string
  validFrom?: string | null
  validUntil?: string | null
  ruleSetVersion: string
  course: { courseId: string; racePlanId?: number | null; name: string; points: PackCoursePoint[] }
  sails: SailInventoryItem[]
  raceHeadsail?: RacePackRaceHeadsail | null
  payload: RacePackPayload
  forecast: PackForecast
  polarSummary?: PolarSummary | null
}

export class RacePackError extends Error {
  constructor(readonly code: string) { super(code) }
}

export const MAX_PACK_BYTES = 1024 * 1024
export const MAX_COURSE_POINTS = 256
export const MAX_SAILS = 128
export const MAX_FORECAST_SAMPLES_PER_LEG = 2048
export const MAX_FORECAST_SAMPLES_TOTAL = 32_768

const KINDS = new Set(['start', 'mark', 'gate', 'finish'])
const ROUNDINGS = new Set(['port', 'starboard', 'either'])
const GATE_ROLES = new Set(['port', 'starboard', 'either'])
const PACK_ID = /^[A-Za-z0-9._:-]{1,128}$/

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function finiteBetween(value: unknown, minimum: number, maximum: number): value is number {
  return isFiniteNumber(value) && value >= minimum && value <= maximum
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function validLatLon(value: unknown): value is PackLatLon {
  const candidate = value as Partial<PackLatLon> | null
  return !!candidate && finiteBetween(candidate.latitude, -90, 90) && finiteBetween(candidate.longitude, -180, 180)
}

function validGate(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object') return false
  const gate = value as PackGate
  if (gate.group != null && (typeof gate.group !== 'string' || gate.group.length > 120)) return false
  if (gate.role != null && !GATE_ROLES.has(gate.role)) return false
  return true
}

function validLine(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object') return false
  const line = value as PackLine
  if (line.port != null && !validLatLon(line.port)) return false
  if (line.starboard != null && !validLatLon(line.starboard)) return false
  return true
}

function validPoint(point: unknown): point is PackCoursePoint {
  const candidate = point as Partial<PackCoursePoint>
  if (!candidate || !validText(candidate.name, 255)) return false
  if (candidate.id != null && !validText(candidate.id, 120)) return false
  if (!finiteBetween(candidate.latitude, -90, 90) || !finiteBetween(candidate.longitude, -180, 180)) return false
  if (candidate.kind !== undefined && !KINDS.has(candidate.kind)) return false
  if (candidate.rounding !== undefined && !ROUNDINGS.has(candidate.rounding)) return false
  if (!validGate(candidate.gate) || !validLine(candidate.line)) return false
  return true
}

function validSample(sample: unknown): sample is PackForecastSample {
  const candidate = sample as Partial<PackForecastSample>
  if (!candidate || !isDateString(candidate.time)) return false
  if (!finiteBetween(candidate.twd_deg, 0, 360) || !finiteBetween(candidate.tws_knots, 0, 200)) return false
  if (candidate.gust_knots != null && !finiteBetween(candidate.gust_knots, 0, 250)) return false
  if (candidate.wave_height_m != null && !finiteBetween(candidate.wave_height_m, 0, 100)) return false
  if (candidate.wave_direction_deg != null && !finiteBetween(candidate.wave_direction_deg, 0, 360)) return false
  if (candidate.current_velocity_kn != null && !finiteBetween(candidate.current_velocity_kn, 0, 50)) return false
  if (candidate.current_direction_deg != null && !finiteBetween(candidate.current_direction_deg, 0, 360)) return false
  return true
}

function validForecastLeg(leg: unknown): leg is PackLegForecast {
  const candidate = leg as Partial<PackLegForecast>
  if (!candidate || !Number.isSafeInteger(candidate.sequence) || (candidate.sequence ?? 0) < 1) return false
  if (candidate.latitude != null && !finiteBetween(candidate.latitude, -90, 90)) return false
  if (candidate.longitude != null && !finiteBetween(candidate.longitude, -180, 180)) return false
  if (!Array.isArray(candidate.samples) || candidate.samples.length < MIN_FORECAST_SAMPLES_PER_LEG || candidate.samples.length > MAX_FORECAST_SAMPLES_PER_LEG) return false
  let previous = Number.NEGATIVE_INFINITY
  for (const sample of candidate.samples) {
    if (!validSample(sample)) return false
    const at = Date.parse(sample.time)
    if (at <= previous) return false
    // A bounded maximum gap keeps every leg responsive to ETA movement.
    if (Number.isFinite(previous) && at - previous > MAX_FORECAST_GAP_MS) throw new RacePackError('forecast_gap_too_large')
    previous = at
  }
  return true
}

function validCoverage(value: unknown): value is PackForecastCoverage {
  if (value == null) return true
  if (typeof value !== 'object') return false
  const coverage = value as Partial<PackForecastCoverage>
  if (!isDateString(coverage.from) || !isDateString(coverage.until)) return false
  return Date.parse(coverage.from) < Date.parse(coverage.until)
}

function validSail(sail: unknown): sail is SailInventoryItem {
  const candidate = sail as Partial<SailInventoryItem>
  return !!candidate && Number.isSafeInteger(candidate.id)
}

function validRaceHeadsail(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object') return false
  const headsail = value as RacePackRaceHeadsail
  if (!Number.isSafeInteger(headsail.sail_id)) return false
  if (headsail.sail_name != null && (typeof headsail.sail_name !== 'string' || headsail.sail_name.length > 255)) return false
  return true
}

export function isSupportedRuleSet(value: unknown): value is SupportedRuleSet {
  return typeof value === 'string' && (SUPPORTED_RULE_SETS as readonly string[]).includes(value)
}

export function parseRacePack(payload: Buffer): RacePack {
  if (payload.length > MAX_PACK_BYTES) throw new RacePackError('pack_too_large')
  let value: unknown
  try { value = JSON.parse(payload.toString('utf8')) } catch { throw new RacePackError('pack_invalid_json') }
  const document = value as Partial<RacePack>
  if (!document || document.v !== 1 || document.kind !== 'race_pack') throw new RacePackError('pack_invalid')
  if (!Number.isSafeInteger(document.revision) || (document.revision ?? 0) < 1) throw new RacePackError('pack_invalid')
  if (!isDateString(document.generatedAt)) throw new RacePackError('pack_invalid')
  if (typeof document.ruleSetVersion !== 'string' || !document.ruleSetVersion.trim()) throw new RacePackError('pack_invalid')
  if (!isSupportedRuleSet(document.ruleSetVersion)) throw new RacePackError('unsupported_rule_set')
  if (document.packId != null && (typeof document.packId !== 'string' || !PACK_ID.test(document.packId))) throw new RacePackError('pack_invalid')
  if (document.racePlanId != null && !Number.isSafeInteger(document.racePlanId)) throw new RacePackError('pack_invalid')
  for (const field of ['validFrom', 'validUntil'] as const) {
    const candidate = document[field]
    if (candidate != null && !isDateString(candidate)) throw new RacePackError('pack_invalid')
  }
  const course = document.course
  if (!course || typeof course !== 'object' || typeof course.courseId !== 'string' || typeof course.name !== 'string') throw new RacePackError('pack_invalid_course')
  if (!Array.isArray(course.points) || course.points.length < 2 || course.points.length > MAX_COURSE_POINTS || !course.points.every(validPoint)) throw new RacePackError('pack_invalid_course')
  if (course.racePlanId != null && !Number.isSafeInteger(course.racePlanId)) throw new RacePackError('pack_invalid_course')
  if (!Array.isArray(document.sails) || document.sails.length > MAX_SAILS || !document.sails.every(validSail)) throw new RacePackError('pack_invalid_sails')
  if (!validRaceHeadsail(document.raceHeadsail)) throw new RacePackError('pack_invalid_race_headsail')
  const forecast = document.forecast
  if (!forecast || typeof forecast !== 'object' || !Array.isArray(forecast.legs)) throw new RacePackError('pack_invalid_forecast')
  if (forecast.snapshot != null && typeof forecast.snapshot !== 'object') throw new RacePackError('pack_invalid_forecast')
  if (!validCoverage(forecast.coverage)) throw new RacePackError('pack_invalid_forecast')
  const expectedLegs = course.points.length - 1
  if (forecast.legs.length !== expectedLegs) throw new RacePackError('forecast_leg_coverage')
  // Coverage window: explicit forecast.coverage wins, otherwise validFrom and
  // validUntil act as the declared coverage window.
  const coverage = forecast.coverage ?? (document.validFrom && document.validUntil ? { from: document.validFrom, until: document.validUntil } : null)
  const coverageFrom = coverage ? Date.parse(coverage.from) : null
  const coverageUntil = coverage ? Date.parse(coverage.until) : null
  let totalSamples = 0
  const sequences = new Set<number>()
  for (const leg of forecast.legs) {
    // Every leg that can become a future remaining leg must carry a real
    // time series (>=2 samples with bounded gaps), not a single stale value.
    if (Array.isArray(leg?.samples) && leg.samples.length < MIN_FORECAST_SAMPLES_PER_LEG) throw new RacePackError('forecast_timeline_insufficient')
    if (!validForecastLeg(leg)) throw new RacePackError('pack_invalid_forecast')
    if (leg.sequence < 1 || leg.sequence > expectedLegs) throw new RacePackError('forecast_leg_coverage')
    if (sequences.has(leg.sequence)) throw new RacePackError('forecast_leg_coverage')
    sequences.add(leg.sequence)
    totalSamples += leg.samples.length
    if (coverageFrom !== null && coverageUntil !== null) {
      const first = Date.parse(leg.samples[0]!.time)
      const last = Date.parse(leg.samples[leg.samples.length - 1]!.time)
      if (first > coverageFrom + MAX_FORECAST_GAP_MS || last < coverageUntil - MAX_FORECAST_GAP_MS) throw new RacePackError('forecast_coverage_gap')
    }
  }
  if (sequences.size !== expectedLegs) throw new RacePackError('forecast_leg_coverage')
  if (totalSamples > MAX_FORECAST_SAMPLES_TOTAL) throw new RacePackError('pack_too_large')
  if (!document.payload || typeof document.payload !== 'object') throw new RacePackError('pack_invalid')
  if (document.polarSummary != null && typeof document.polarSummary !== 'object') throw new RacePackError('pack_invalid')
  return document as RacePack
}

export interface RacePackIdentity {
  packId: string | null
  revision: number
  racePlanId: number | null
  courseId: string
  ruleSetVersion: string
  generatedAt: string
  validFrom: string | null
  validUntil: string | null
}

export function racePackIdentity(pack: RacePack): RacePackIdentity {
  return {
    packId: pack.packId ?? null,
    revision: pack.revision,
    racePlanId: pack.racePlanId ?? pack.course.racePlanId ?? null,
    courseId: pack.course.courseId,
    ruleSetVersion: pack.ruleSetVersion,
    generatedAt: pack.generatedAt,
    validFrom: pack.validFrom ?? null,
    validUntil: pack.validUntil ?? null
  }
}

export function racePackAppliesToCourse(pack: RacePack, course: { courseId?: string | null; racePlanId?: number | null } | null | undefined): boolean {
  if (!course || !course.courseId || course.courseId !== pack.course.courseId) return false
  const packPlan = pack.racePlanId ?? pack.course.racePlanId ?? null
  if (course.racePlanId != null && packPlan != null && course.racePlanId !== packPlan) return false
  return true
}

export function packValidityAt(pack: RacePack, now: number): 'valid' | 'not_yet' | 'expired' | 'unknown' {
  const from = pack.validFrom ? Date.parse(pack.validFrom) : Number.NaN
  const until = pack.validUntil ? Date.parse(pack.validUntil) : Number.NaN
  if (Number.isFinite(from) && now < from) return 'not_yet'
  if (Number.isFinite(until) && now > until) return 'expired'
  if (Number.isFinite(from) || Number.isFinite(until)) return 'valid'
  return 'unknown'
}
