import type { PolarSummary } from './sailing/physics'
import type { SailInventoryItem } from './sailing/selection'

export type PackRounding = 'port' | 'starboard' | 'either'
export type PackPointKind = 'start' | 'mark' | 'gate' | 'finish'

export interface PackCoursePoint {
  name: string
  latitude: number
  longitude: number
  kind?: PackPointKind
  rounding?: PackRounding
}

export interface PackLegForecast {
  sequence: number
  sample_time?: string | null
  twd_deg: number
  tws_knots: number
  gust_knots?: number | null
  latitude?: number | null
  longitude?: number | null
  wave_height_m?: number | null
  wave_direction_deg?: number | null
  current_velocity_kn?: number | null
  current_direction_deg?: number | null
}

export interface RacePackPayload {
  startTime?: string | null
  availableCrewCount?: number | null
  [key: string]: unknown
}

export interface RacePack {
  v: 1
  kind: 'race_pack'
  revision: number
  generatedAt: string
  ruleSetVersion: string
  course: { courseId: string; racePlanId?: number | null; name: string; points: PackCoursePoint[] }
  sails: SailInventoryItem[]
  payload: RacePackPayload
  legForecasts: PackLegForecast[]
  forecastSnapshot?: Record<string, unknown>
  polarSummary?: PolarSummary | null
}

export class RacePackError extends Error {
  constructor(readonly code: string) { super(code) }
}

const MAX_PACK_BYTES = 256 * 1024
const KINDS = new Set(['start', 'mark', 'gate', 'finish'])
const ROUNDINGS = new Set(['port', 'starboard', 'either'])

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validPoint(point: unknown): point is PackCoursePoint {
  const candidate = point as Partial<PackCoursePoint>
  if (!candidate || typeof candidate.name !== 'string' || !candidate.name.trim()) return false
  if (!isFiniteNumber(candidate.latitude) || candidate.latitude < -90 || candidate.latitude > 90) return false
  if (!isFiniteNumber(candidate.longitude) || candidate.longitude < -180 || candidate.longitude > 180) return false
  if (candidate.kind !== undefined && !KINDS.has(candidate.kind)) return false
  if (candidate.rounding !== undefined && !ROUNDINGS.has(candidate.rounding)) return false
  return true
}

function validForecast(forecast: unknown): forecast is PackLegForecast {
  const candidate = forecast as Partial<PackLegForecast>
  if (!candidate || !Number.isSafeInteger(candidate.sequence)) return false
  if (!isFiniteNumber(candidate.twd_deg) || !isFiniteNumber(candidate.tws_knots)) return false
  if (candidate.sample_time != null && (typeof candidate.sample_time !== 'string' || !Number.isFinite(Date.parse(candidate.sample_time)))) return false
  return true
}

function validSail(sail: unknown): sail is SailInventoryItem {
  const candidate = sail as Partial<SailInventoryItem>
  return !!candidate && Number.isSafeInteger(candidate.id)
}

export function parseRacePack(payload: Buffer): RacePack {
  if (payload.length > MAX_PACK_BYTES) throw new RacePackError('pack_too_large')
  let value: unknown
  try { value = JSON.parse(payload.toString('utf8')) } catch { throw new RacePackError('pack_invalid_json') }
  const document = value as Partial<RacePack>
  if (!document || document.v !== 1 || document.kind !== 'race_pack') throw new RacePackError('pack_invalid')
  if (!Number.isSafeInteger(document.revision) || (document.revision ?? 0) < 1) throw new RacePackError('pack_invalid')
  if (typeof document.generatedAt !== 'string' || !Number.isFinite(Date.parse(document.generatedAt))) throw new RacePackError('pack_invalid')
  if (typeof document.ruleSetVersion !== 'string' || !document.ruleSetVersion.trim()) throw new RacePackError('pack_invalid')
  const course = document.course
  if (!course || typeof course !== 'object' || typeof course.courseId !== 'string' || typeof course.name !== 'string') throw new RacePackError('pack_invalid_course')
  if (!Array.isArray(course.points) || course.points.length < 2 || !course.points.every(validPoint)) throw new RacePackError('pack_invalid_course')
  if (!Array.isArray(document.sails) || !document.sails.every(validSail)) throw new RacePackError('pack_invalid_sails')
  if (!Array.isArray(document.legForecasts) || !document.legForecasts.every(validForecast)) throw new RacePackError('pack_invalid_forecasts')
  if (!document.payload || typeof document.payload !== 'object') throw new RacePackError('pack_invalid')
  if (document.polarSummary != null && typeof document.polarSummary !== 'object') throw new RacePackError('pack_invalid')
  return document as RacePack
}