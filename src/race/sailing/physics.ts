const EARTH_RADIUS_M = 6_371_000
const METRES_PER_NAUTICAL_MILE = 1852
const METRES_TO_FEET = 3.280839895

const POINT_OF_SAIL_NO_SAIL_MAX = 35
const POINT_OF_SAIL_CLOSE_HAULED_MAX = 60
const POINT_OF_SAIL_CLOSE_REACH_MAX = 90
const POINT_OF_SAIL_BROAD_REACH_MAX = 135

const DEFAULT_UPWIND_TARGET_TWA_DEG = 45

const POINT_SPEED_MULTIPLIERS: Record<string, number> = {
  'close-hauled / no-sail zone': 0.35,
  'close-hauled': 0.6,
  'close reach': 0.75,
  'beam reach': 0.85,
  'broad reach': 0.75,
  running: 0.65
}

export interface VesselPerformance {
  hull_speed_knots?: number | null
  length_waterline_m?: number | null
  length_m?: number | null
}

export interface PolarBucket {
  abs_twa_deg?: number | null
  twa_deg?: number | null
  tws_kn?: number | null
  average_speed_kn?: number | null
  target_speed_kn?: number | null
  sample_count?: number | null
  side?: string | null
  label?: string | null
}

export interface PolarSummary {
  eligible?: boolean
  buckets?: PolarBucket[] | null
}

export interface PolarSpeedMatch {
  source: 'saved_polar'
  bucketLabel: string | null
  bucketSide: string | null
  bucketTwaDeg: number | null
  bucketTwsKn: number | null
  sampleCount: number
}

export interface ApparentWindResult {
  apparentWindFromDeg: number
  awaDeg: number
  awsKnots: number
}

export interface CurrentComponents {
  currentAngleToLegDeg: number | null
  currentAlongLegKn: number | null
  currentCrossLegKn: number | null
  estimatedSogDeltaKn: number
}

function pyRound(value: number, digits: number): number {
  const factor = 10 ** digits
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const fraction = scaled - floor
  const rounded = fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled)
  return rounded / factor
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

export function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360
}

export function angularDifferenceDegrees(left: number, right: number): number {
  const delta = Math.abs(normalizeDegrees(left) - normalizeDegrees(right)) % 360
  return Math.min(delta, 360 - delta)
}

export function signedAngleDegrees(left: number, right: number): number {
  return ((normalizeDegrees(left) - normalizeDegrees(right) + 540) % 360) - 180
}

export function bearingDegrees(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const lat1 = fromLat * Math.PI / 180
  const lat2 = toLat * Math.PI / 180
  const dlon = (toLon - fromLon) * Math.PI / 180
  const y = Math.sin(dlon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon)
  return pyRound(normalizeDegrees(Math.atan2(y, x) * 180 / Math.PI), 1)
}

export function distanceNm(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const lat1 = fromLat * Math.PI / 180
  const lat2 = toLat * Math.PI / 180
  const dlat = lat2 - lat1
  const dlon = (toLon - fromLon) * Math.PI / 180
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2
  return pyRound((EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))) / METRES_PER_NAUTICAL_MILE, 3)
}

export function classifyPointOfSail(twaDeg: number): string {
  const twa = Math.max(0, Math.min(180, twaDeg))
  if (twa < POINT_OF_SAIL_NO_SAIL_MAX) return 'close-hauled'
  if (twa < POINT_OF_SAIL_CLOSE_HAULED_MAX) return 'close-hauled'
  if (twa < POINT_OF_SAIL_CLOSE_REACH_MAX) return 'close reach'
  if (Math.abs(twa - POINT_OF_SAIL_CLOSE_REACH_MAX) <= 0.5) return 'beam reach'
  if (twa < POINT_OF_SAIL_BROAD_REACH_MAX) return 'broad reach'
  return 'running'
}

export function bestUpwindTargetFromPolarSummary(polarSummary: PolarSummary | null | undefined, forecastTwsKnots: number): [number, string] {
  if (!polarSummary || typeof polarSummary !== 'object' || !polarSummary.eligible) return [DEFAULT_UPWIND_TARGET_TWA_DEG, 'default']
  const buckets = Array.isArray(polarSummary.buckets) ? polarSummary.buckets : []
  const candidates: Array<{ vmg: number; samples: number; twa: number }> = []
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== 'object') continue
    const absTwa = num(bucket.abs_twa_deg || bucket.twa_deg)
    const speed = num(bucket.average_speed_kn || bucket.target_speed_kn)
    const tws = num(bucket.tws_kn)
    const samples = int(bucket.sample_count) ?? 0
    if (absTwa === null || speed === null || absTwa < 35 || absTwa > 60) continue
    let twsWeight = 1
    if (tws !== null) twsWeight = Math.max(0.65, 1 - Math.min(Math.abs(tws - forecastTwsKnots), 10) / 30)
    const windwardVmg = speed * Math.cos(absTwa * Math.PI / 180) * twsWeight
    candidates.push({ vmg: windwardVmg, samples, twa: absTwa })
  }
  if (!candidates.length) return [DEFAULT_UPWIND_TARGET_TWA_DEG, 'default']
  let best = candidates[0]!
  for (const candidate of candidates) {
    if (candidate.vmg > best.vmg || (candidate.vmg === best.vmg && candidate.samples > best.samples)) best = candidate
  }
  return [pyRound(best.twa, 1), 'polar']
}

export function polarSpeedForLeg(
  polarSummary: PolarSummary | null | undefined,
  options: { twaDeg: number; forecastTwsKnots: number; windSide?: string | null }
): [number | null, PolarSpeedMatch | null] {
  if (!polarSummary || typeof polarSummary !== 'object' || !polarSummary.eligible) return [null, null]
  const buckets = Array.isArray(polarSummary.buckets) ? polarSummary.buckets : []
  const side = (options.windSide ?? '').trim().toLowerCase()
  const candidates: Array<{ score: number; samples: number; speed: number; bucket: PolarBucket }> = []
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== 'object') continue
    const absTwa = num(bucket.abs_twa_deg || bucket.twa_deg)
    const tws = num(bucket.tws_kn)
    const speed = num(bucket.average_speed_kn) || num(bucket.target_speed_kn)
    const samples = int(bucket.sample_count) ?? 0
    if (absTwa === null || tws === null || speed === null || speed <= 0) continue
    const angleDelta = Math.abs(absTwa - options.twaDeg)
    const windDelta = Math.abs(tws - options.forecastTwsKnots)
    if (angleDelta > 25 || windDelta > 10) continue
    let sidePenalty = 0
    const bucketSide = (bucket.side ?? '').trim().toLowerCase()
    if (side && bucketSide && side !== bucketSide) sidePenalty = 6
    const score = angleDelta * 1.4 + windDelta * 2 + sidePenalty - Math.min(samples, 80) * 0.03
    candidates.push({ score, samples, speed, bucket })
  }
  if (!candidates.length) return [null, null]
  let best = candidates[0]!
  for (const candidate of candidates) {
    if (candidate.score < best.score || (candidate.score === best.score && candidate.samples > best.samples)) best = candidate
  }
  return [pyRound(best.speed, 2), {
    source: 'saved_polar',
    bucketLabel: best.bucket.label ?? null,
    bucketSide: best.bucket.side ?? null,
    bucketTwaDeg: num(best.bucket.abs_twa_deg || best.bucket.twa_deg),
    bucketTwsKn: num(best.bucket.tws_kn),
    sampleCount: best.samples
  }]
}

export function sailingCourseForTargetTwa(options: { legBearingDeg: number; trueWindFromDeg: number; targetTwaDeg: number }): number {
  const candidates = [
    normalizeDegrees(options.trueWindFromDeg + options.targetTwaDeg),
    normalizeDegrees(options.trueWindFromDeg - options.targetTwaDeg)
  ]
  let best = candidates[0]!
  for (const candidate of candidates) {
    if (angularDifferenceDegrees(candidate, options.legBearingDeg) < angularDifferenceDegrees(best, options.legBearingDeg)) best = candidate
  }
  return pyRound(best, 1)
}

export function sailingSideForCourse(options: { sailingCourseDeg: number; trueWindFromDeg: number; pointOfSail: string }): { wind_side: string; tack: string; sails_out_side: string | null } {
  const signed = signedAngleDegrees(options.trueWindFromDeg, options.sailingCourseDeg)
  const windSide = signed > 0 ? 'starboard' : 'port'
  let sailsOutSide: string | null = null
  if (options.pointOfSail === 'broad reach' || options.pointOfSail === 'running') {
    sailsOutSide = windSide === 'starboard' ? 'port' : 'starboard'
  }
  return { wind_side: windSide, tack: windSide, sails_out_side: sailsOutSide }
}

export function hullSpeedForVessel(vessel: VesselPerformance): [number, string] {
  const explicit = num(vessel.hull_speed_knots)
  if (explicit !== null && explicit > 0) return [explicit, 'vessel hull speed']
  const fields: Array<[keyof VesselPerformance, string]> = [['length_waterline_m', 'length at waterline'], ['length_m', 'vessel length']]
  for (const [field, reason] of fields) {
    const length = num(vessel[field])
    if (length !== null && length > 0) return [1.34 * Math.sqrt(length * METRES_TO_FEET), reason]
  }
  return [5, 'default hull speed']
}

export function estimateBoatSpeedKnots(options: { vessel: VesselPerformance; pointOfSail: string; forecastTwsKnots: number; forecastGustKnots: number }): [number, string[]] {
  const [hullSpeed, source] = hullSpeedForVessel(options.vessel)
  const multiplier = POINT_SPEED_MULTIPLIERS[options.pointOfSail] ?? 0.6
  let speed = hullSpeed * multiplier
  const warnings: string[] = []
  if (source === 'default hull speed') warnings.push('Estimated speed uses a default hull speed because vessel performance fields are incomplete.')
  if (options.pointOfSail === 'close-hauled / no-sail zone') warnings.push('Leg is very close to the wind; sailing performance may be poor without tacking.')
  if (options.forecastTwsKnots < 5) {
    speed *= 0.45
    warnings.push('Light wind may substantially reduce boat speed.')
  } else if (options.forecastTwsKnots < 8) {
    speed *= 0.7
    warnings.push('Light wind may moderately reduce boat speed.')
  }
  if (options.forecastGustKnots >= Math.max(20, options.forecastTwsKnots + 10)) {
    speed *= 0.9
    warnings.push('Gust spread is high; estimated speed confidence is reduced.')
  }
  return [pyRound(Math.max(0.1, speed), 2), warnings]
}

function vectorFromBearing(directionDeg: number, speed: number): { x: number; y: number } {
  const radians = normalizeDegrees(directionDeg) * Math.PI / 180
  return { x: Math.sin(radians) * speed, y: Math.cos(radians) * speed }
}

export function apparentWind(options: { vesselCourseDeg: number; vesselSpeedKnots: number; trueWindFromDeg: number; trueWindSpeedKnots: number }): ApparentWindResult {
  const trueWindToDeg = normalizeDegrees(options.trueWindFromDeg + 180)
  const trueWind = vectorFromBearing(trueWindToDeg, options.trueWindSpeedKnots)
  const vessel = vectorFromBearing(options.vesselCourseDeg, options.vesselSpeedKnots)
  const apparentToX = trueWind.x - vessel.x
  const apparentToY = trueWind.y - vessel.y
  const aws = Math.hypot(apparentToX, apparentToY)
  const apparentToDeg = aws > 0 ? normalizeDegrees(Math.atan2(apparentToX, apparentToY) * 180 / Math.PI) : normalizeDegrees(trueWindToDeg)
  const apparentFromDeg = normalizeDegrees(apparentToDeg + 180)
  return {
    apparentWindFromDeg: pyRound(apparentFromDeg, 1),
    awaDeg: pyRound(angularDifferenceDegrees(options.vesselCourseDeg, apparentFromDeg), 1),
    awsKnots: pyRound(aws, 2)
  }
}

export function currentComponents(options: { currentVelocityKn: number | null; currentDirectionDeg: number | null; legBearingDeg: number }): CurrentComponents {
  if (options.currentVelocityKn === null || options.currentDirectionDeg === null) {
    return { currentAngleToLegDeg: null, currentAlongLegKn: null, currentCrossLegKn: null, estimatedSogDeltaKn: 0 }
  }
  const angle = angularDifferenceDegrees(options.legBearingDeg, options.currentDirectionDeg)
  const radians = angle * Math.PI / 180
  const along = options.currentVelocityKn * Math.cos(radians)
  const cross = options.currentVelocityKn * Math.sin(radians)
  return {
    currentAngleToLegDeg: pyRound(angle, 1),
    currentAlongLegKn: pyRound(along, 2),
    currentCrossLegKn: pyRound(cross, 2),
    estimatedSogDeltaKn: along
  }
}

export function waveAngleToLeg(options: { waveDirectionDeg: number | null; legBearingDeg: number }): number | null {
  if (options.waveDirectionDeg === null) return null
  return pyRound(angularDifferenceDegrees(options.legBearingDeg, options.waveDirectionDeg), 1)
}