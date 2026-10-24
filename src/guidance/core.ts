/** Canonical sailing guidance. Browser copies are generated, never hand-tuned. */
export const GUIDANCE_VERSION = 1 as const
export const GUIDANCE_ALGORITHM = 'sailing-guidance-v1'
export interface Reading { value: number; at: number; source?: string }
export interface WindReading { east: number; north: number; at: number; source?: string; validUntil?: number }
export interface GuidanceInput {
  at: number; session?: string; heading?: Reading | null; wind?: WindReading | null
  waterWind?: WindReading | null; apparentWind?: WindReading | null
  sog?: Reading | null; cog?: Reading | null; stw?: Reading | null
  pitch?: Reading | null; yaw?: Reading | null; heel?: Reading | null; rudder?: Reading | null; leeway?: Reading | null
  rateOfTurn?: Reading | null; current?: WindReading | null
}
export interface LeewayCalibration {
  id: string; validated: true; heelCoefficient: number
  portHeelCoefficient?: number; starboardHeelCoefficient?: number
  rudderCoefficient?: number; minSpeedKn?: number; maxLeewayDeg?: number
}
export interface PolarPoint { twsKn: number; upwindTwaDeg: number; upwindSpeedKn: number; downwindTwaDeg: number; downwindSpeedKn: number }
export interface PolarTable { id: string; validated: true; points: PolarPoint[] }
export interface GuidanceConfig { polar?: PolarTable; enabled?: boolean; maxAgeMs?: number; headingTauSeconds?: number; windTauSeconds?: number; calibration?: LeewayCalibration }
export interface GuidanceSnapshot {
  v: 1; algorithm: string; at: number; headingAt: number; windAt: number | null
  headingDeg: number; windFromDeg: number | null; windSpeedKn: number | null
  headingValidUntil: number; windValidUntil: number | null
  // Additive selection; existing wind fields remain ground referenced.
  sailingWindFromDeg?: number | null; sailingWindSpeedKn?: number | null
  sailingWindAt?: number | null; sailingWindValidUntil?: number | null
  sailingWindBasis?: 'water' | 'ground' | 'unavailable'
  kind: 'tack' | 'gybe' | null; currentTack: 'port' | 'starboard' | null; turning: boolean; motionUnstable: boolean
  waterWindFromDeg: number | null; waterSpeedKn: number | null
  targetTwaDeg: number | null; targetSpeedKn: number | null
  currentEastKn: number | null; currentNorthKn: number | null; currentAt: number | null
  currentBasis: 'provided' | 'derived' | 'unavailable'; currentValidUntil: number | null
  leewayDeg: number | null; oppositeLeewayDeg: number | null; leewayAt: number | null
  leewayBasis: 'measured' | 'calibrated-rudder' | 'calibrated-heel' | 'unavailable'
  correctionValidUntil: number | null
  inputs: Record<string, Reading>
}
export interface GuideBearings {
  headingDeg: number | null; waterCourseDeg: number | null; currentCourseDeg: number | null; oppositeCourseDeg: number | null
  oppositeHeadingDeg: number | null; trueWindFromDeg: number | null; trueWindSpeedKn: number | null
  currentTack: 'port' | 'starboard' | null; kind: 'tack' | 'gybe' | null
  courseToSteerDeg: number | null; corrected: boolean; turning: boolean
}
export const normalizeDegrees = (x: number): number => ((x % 360) + 360) % 360
export const signedDegrees = (x: number): number => normalizeDegrees(x + 180) - 180
const rad = (x: number): number => x * Math.PI / 180
const deg = (x: number): number => x * 180 / Math.PI
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const vector = (speed: number, bearing: number): [number, number] => [speed * Math.sin(rad(bearing)), speed * Math.cos(rad(bearing))]
const direction = (east: number, north: number): number => normalizeDegrees(deg(Math.atan2(east, north)))
const fresh = (x: Reading | WindReading | null | undefined, at: number, age: number): boolean => !!x && finite(x.at) && at >= x.at - 1000 && at - x.at <= age
const scalar = (x: Reading | null | undefined, at: number, age: number, low: number, high: number): x is Reading => fresh(x, at, age) && finite(x?.value) && x.value >= low && x.value <= high
const windFresh = (x: WindReading | null | undefined, at: number, age: number): x is WindReading => fresh(x, at, age) && (x?.validUntil === undefined || at <= x.validUntil) && finite(x?.east) && finite(x?.north) && Math.hypot(x.east, x.north) <= 200
const round = (x: number): number => Math.round(x * 1e6) / 1e6

class VectorFilter {
  private east = 0
  private north = 0
  private at = -Infinity
  private source = ''
  reset(): void { this.at = -Infinity }
  update(east: number, north: number, at: number, source: string, tau: number): [number, number] {
    if (source !== this.source || at - this.at > 10000) {
      this.east = east; this.north = north; this.source = source; this.at = at
    } else if (at > this.at) {
      const alpha = tau <= 0 ? 1 : 1 - Math.exp(-(at - this.at) / (tau * 1000))
      this.east += alpha * (east - this.east); this.north += alpha * (north - this.north); this.at = at
    }
    return [this.east, this.north]
  }
}

export class GuidanceEngine {
  private headingFilter = new VectorFilter()
  private windFilter = new VectorFilter()
  private waterWindFilter = new VectorFilter()
  private currentFilter = new VectorFilter()
  private leewayFilter = new VectorFilter()
  private oppositeLeewayFilter = new VectorFilter()
  private lastHeading: Reading | null = null
  private turnStart: number | null = null
  private turnDirection = 0
  private turnUntil = -Infinity
  private session: string | undefined
  private lastAt = -Infinity
  private mode: 'tack' | 'gybe' | null = null
  private side: 'port' | 'starboard' | null = null
  private result: GuidanceSnapshot | null = null
  constructor(private readonly config: GuidanceConfig = {}) {}
  reset(): void {
    this.headingFilter.reset(); this.windFilter.reset(); this.waterWindFilter.reset(); this.currentFilter.reset(); this.leewayFilter.reset(); this.oppositeLeewayFilter.reset()
    this.lastHeading = null; this.lastAt = -Infinity; this.turnStart = null; this.turnUntil = -Infinity
    this.mode = null; this.side = null; this.result = null
  }
  update(input: GuidanceInput): GuidanceSnapshot | null {
    const at = input.at, age = this.config.maxAgeMs ?? 30000
    if (!finite(at)) return null
    if (at < this.lastAt) return this.result ? structuredClone(this.result) : null
    if (this.session !== input.session || this.lastHeading && input.heading && input.heading.at - this.lastHeading.at > 10000) this.reset()
    this.session = input.session; this.lastAt = at
    const h = input.heading
    if (!scalar(h, at, age, -3600, 3600)) { this.result = null; this.headingFilter.reset(); return null }
    const previous = this.lastHeading
    if (previous && h.at > previous.at) {
      const elapsed = (h.at - previous.at) / 1000
      const change = signedDegrees(h.value - previous.value)
      const rate = scalar(input.rateOfTurn, at, age, -180, 180) ? input.rateOfTurn.value : change / elapsed
      const rudderEvidence = scalar(input.rudder, at, age, -45, 45) && Math.abs(input.rudder.value) > 3
      const turnThreshold = rudderEvidence ? 1.5 : 3
      if (Math.abs(change) >= 30 && elapsed <= 3) {
        // A confirmed large course change must not average opposite tacks.
        this.headingFilter.reset(); this.turnUntil = h.at + 1500
      } else if (Math.abs(rate) > turnThreshold) {
        if (Math.sign(rate) !== this.turnDirection) this.turnStart = h.at
        this.turnDirection = Math.sign(rate); this.turnStart ??= h.at
        if (h.at - this.turnStart >= 700) this.turnUntil = h.at + 1500
      } else this.turnStart = null
    }
    if (!previous || h.at >= previous.at) this.lastHeading = { ...h }
    const turning = at < this.turnUntil
    const hv = vector(1, h.value)
    const [he, hn] = this.headingFilter.update(hv[0], hv[1], h.at, h.source ?? '', turning ? 0.35 : this.config.headingTauSeconds ?? 2)
    if (Math.hypot(he, hn) < 0.05) { this.result = null; return null }
    const heading = direction(he, hn), inputs: Record<string, Reading> = { heading: { ...h } }
    for (const name of ['sog', 'cog', 'stw', 'heel', 'pitch', 'yaw', 'rudder', 'leeway', 'rateOfTurn'] as const) {
      const value = input[name]
      const bounds: Record<string, [number, number]> = { sog: [0, 80], cog: [-3600, 3600], stw: [0, 80], heel: [-90, 90], pitch: [-90, 90], yaw: [-3600, 3600], rudder: [-45, 45], leeway: [-25, 25], rateOfTurn: [-180, 180] }
      const [low, high] = bounds[name]!
      if (scalar(value, at, age, low, high)) inputs[name] = { ...value }
    }
    const s: GuidanceSnapshot = {
      v: 1, algorithm: GUIDANCE_ALGORITHM, at, headingAt: h.at, headingDeg: round(heading), headingValidUntil: h.at + age,
      windAt: null, windFromDeg: null, windSpeedKn: null, windValidUntil: null,
      sailingWindFromDeg: null, sailingWindSpeedKn: null, sailingWindAt: null, sailingWindValidUntil: null, sailingWindBasis: 'unavailable',
      kind: null, currentTack: null, turning, motionUnstable: scalar(input.heel, at, age, -90, 90) && Math.abs(input.heel.value) > 45 || scalar(input.pitch, at, age, -90, 90) && Math.abs(input.pitch.value) > 30, waterWindFromDeg: null, waterSpeedKn: null, targetTwaDeg: null, targetSpeedKn: null,
      currentEastKn: null, currentNorthKn: null, currentAt: null, currentBasis: 'unavailable', currentValidUntil: null,
      leewayDeg: null, oppositeLeewayDeg: null, leewayAt: null, leewayBasis: 'unavailable', correctionValidUntil: null, inputs
    }
    const stw = input.stw, heel = input.heel, rudder = input.rudder, measuredLeeway = input.leeway
    const speedValid = scalar(stw, at, age, 0.5, 80)
    if (speedValid) s.waterSpeedKn = stw.value
    const calibration = this.config.calibration
    if (scalar(measuredLeeway, at, age, -25, 25)) {
      s.leewayDeg = measuredLeeway.value; s.oppositeLeewayDeg = -measuredLeeway.value
      s.leewayAt = measuredLeeway.at; s.leewayBasis = 'measured'
    } else if (calibration?.validated === true && calibration.id && speedValid && scalar(heel, at, age, -60, 60)
      && finite(calibration.heelCoefficient) && Math.abs(calibration.heelCoefficient) <= 100
      && stw.value >= Math.max(0.5, calibration.minSpeedKn ?? 2) && !turning) {
      const coefficient = heel.value >= 0 ? calibration.starboardHeelCoefficient ?? calibration.heelCoefficient : calibration.portHeelCoefficient ?? calibration.heelCoefficient
      const oppositeCoefficient = heel.value >= 0 ? calibration.portHeelCoefficient ?? calibration.heelCoefficient : calibration.starboardHeelCoefficient ?? calibration.heelCoefficient
      const base = coefficient * heel.value / stw.value ** 2
      const useRudder = scalar(rudder, at, age, -45, 45) && finite(calibration.rudderCoefficient) && Math.abs(calibration.rudderCoefficient) <= 2
      const estimate = base + (useRudder ? calibration.rudderCoefficient! * rudder.value : 0)
      const limit = Math.min(25, Math.max(0, calibration.maxLeewayDeg ?? 15))
      if (finite(estimate) && Math.abs(estimate) <= limit && finite(oppositeCoefficient)) {
        s.leewayDeg = estimate; s.oppositeLeewayDeg = -oppositeCoefficient * heel.value / stw.value ** 2
        if (Math.abs(s.oppositeLeewayDeg) > limit) s.oppositeLeewayDeg = null
        s.leewayAt = Math.min(stw.at, heel.at, useRudder ? rudder.at : Infinity)
        s.leewayBasis = useRudder ? 'calibrated-rudder' : 'calibrated-heel'
      }
    }
    if (s.leewayDeg !== null && s.leewayAt !== null) {
      const [east, north] = this.leewayFilter.update(...vector(1, s.leewayDeg), s.leewayAt, s.leewayBasis === 'measured' ? 'measured' : calibration?.id ?? '', 2)
      s.leewayDeg = signedDegrees(direction(east, north))
      if (s.oppositeLeewayDeg !== null) {
        const [oe, on] = this.oppositeLeewayFilter.update(...vector(1, s.oppositeLeewayDeg), s.leewayAt, s.leewayBasis === 'measured' ? 'measured' : calibration?.id ?? '', 2)
        s.oppositeLeewayDeg = signedDegrees(direction(oe, on))
      }
    } else { this.leewayFilter.reset(); this.oppositeLeewayFilter.reset() }
    if (speedValid) s.waterSpeedKn = stw.value / Math.cos(rad(s.leewayDeg ?? 0))
    let current: WindReading | null = null
    if (windFresh(input.current, at, age) && Math.hypot(input.current.east, input.current.north) <= 15) {
      current = input.current; s.currentBasis = 'provided'
    } else if (speedValid && s.leewayDeg !== null && scalar(input.sog, at, age, 0, 80) && scalar(input.cog, at, age, -3600, 3600)
      && Math.max(h.at, stw.at, input.sog.at, input.cog.at) - Math.min(h.at, stw.at, input.sog.at, input.cog.at) <= 2000 && !turning) {
      const water = vector(s.waterSpeedKn!, h.value + s.leewayDeg), ground = vector(input.sog.value, input.cog.value)
      current = { east: ground[0] - water[0], north: ground[1] - water[1], at: Math.min(h.at, stw.at, input.sog.at, input.cog.at, s.leewayAt!), source: 'water-ground-residual:' + s.leewayBasis }
      if (Math.hypot(current.east, current.north) <= 15) s.currentBasis = 'derived'
      else current = null
    }
    if (current) {
      const [east, north] = this.currentFilter.update(current.east, current.north, current.at, current.source ?? s.currentBasis, 8)
      s.currentEastKn = round(east); s.currentNorthKn = round(north); s.currentAt = current.at; s.currentValidUntil = current.at + age
      s.inputs.currentEast = { value: current.east, at: current.at, source: current.source }
      s.inputs.currentNorth = { value: current.north, at: current.at, source: current.source }
    }
    if (speedValid) s.correctionValidUntil = Math.min(stw.at + age, s.leewayAt === null ? Infinity : s.leewayAt + age, s.currentValidUntil ?? Infinity)
    if (windFresh(input.wind, at, age)) {
      const [east, north] = this.windFilter.update(input.wind.east, input.wind.north, input.wind.at, input.wind.source ?? '', this.config.windTauSeconds ?? 5)
      const speed = Math.hypot(east, north)
      if (speed > 0.1) {
        s.windAt = input.wind.at; s.windValidUntil = input.wind.validUntil ?? input.wind.at + age
        s.windFromDeg = round(direction(east, north)); s.windSpeedKn = round(speed)
        s.inputs.windEast = { value: input.wind.east, at: input.wind.at, source: input.wind.source }
        s.inputs.windNorth = { value: input.wind.north, at: input.wind.at, source: input.wind.source }
        // Meteorological FROM vectors: water wind = ground wind + current TO.
        const waterEast = east + (current ? s.currentEastKn! : 0), waterNorth = north + (current ? s.currentNorthKn! : 0)
        if (Math.hypot(waterEast, waterNorth) > 0.1) s.waterWindFromDeg = round(direction(waterEast, waterNorth))
      }
    } else this.windFilter.reset()
    let waterWind = windFresh(input.waterWind, at, age) ? input.waterWind : null
    const apparent = input.apparentWind
    if (!waterWind && speedValid && windFresh(apparent, at, age)) {
      const clocks = [apparent.at, h.at, stw.at, ...(s.leewayAt === null ? [] : [s.leewayAt])]
      if (Math.max(...clocks) - Math.min(...clocks) <= 2000) {
        const waterVelocity = vector(s.waterSpeedKn!, h.value + (s.leewayDeg ?? 0))
        waterWind = { east: apparent.east - waterVelocity[0], north: apparent.north - waterVelocity[1],
          at: Math.min(...clocks), validUntil: Math.min(apparent.validUntil ?? apparent.at + age, ...clocks.map(clock => clock + age)),
          source: 'apparent-water:' + apparent.source + ':' + stw.source + ':' + s.leewayBasis }
      }
    }
    if (waterWind && !windFresh(waterWind, at, age)) waterWind = null
    if (waterWind) {
      const [east, north] = this.waterWindFilter.update(waterWind.east, waterWind.north, waterWind.at, waterWind.source ?? '', this.config.windTauSeconds ?? 5)
      if (Math.hypot(east, north) > 0.1) {
        s.sailingWindFromDeg = round(direction(east, north)); s.sailingWindSpeedKn = round(Math.hypot(east, north))
        s.sailingWindAt = waterWind.at; s.sailingWindValidUntil = waterWind.validUntil ?? waterWind.at + age; s.sailingWindBasis = 'water'
        s.waterWindFromDeg = s.sailingWindFromDeg
        s.inputs.waterWindEast = { value: waterWind.east, at: waterWind.at, source: waterWind.source }
        s.inputs.waterWindNorth = { value: waterWind.north, at: waterWind.at, source: waterWind.source }
      }
    } else this.waterWindFilter.reset()
    if (!waterWind && s.sailingWindBasis === 'unavailable' && s.windFromDeg !== null && s.windSpeedKn !== null) {
      const east = s.windSpeedKn * Math.sin(rad(s.windFromDeg)) + (current ? s.currentEastKn! : 0)
      const north = s.windSpeedKn * Math.cos(rad(s.windFromDeg)) + (current ? s.currentNorthKn! : 0)
      if (Math.hypot(east, north) > 0.1) {
        s.sailingWindFromDeg = round(direction(east, north)); s.sailingWindSpeedKn = round(Math.hypot(east, north))
        s.sailingWindAt = current ? Math.min(s.windAt!, s.currentAt!) : s.windAt
        s.sailingWindValidUntil = current ? Math.min(s.windValidUntil!, s.currentValidUntil!) : s.windValidUntil
        s.sailingWindBasis = current ? 'water' : 'ground'
      }
    }
    if (s.sailingWindFromDeg !== null && s.sailingWindFromDeg !== undefined && s.sailingWindSpeedKn !== null && s.sailingWindSpeedKn !== undefined) {
      const twa = signedDegrees(s.sailingWindFromDeg - heading), angle = Math.abs(twa)
      if (angle >= 20 && angle < 87 || this.mode === 'tack' && angle >= 17 && angle < 93) this.mode = 'tack'
      else if (angle > 103 && angle < 175 || this.mode === 'gybe' && angle > 97 && angle < 178) this.mode = 'gybe'
      else this.mode = null
      if (Math.abs(twa) >= 3 && Math.abs(twa) <= 177) this.side = twa > 0 ? 'starboard' : 'port'
      if (!turning && !s.motionUnstable) { s.kind = this.mode; s.currentTack = this.mode ? this.side : null }
      const polar = this.config.polar
      if (s.kind && polar?.validated === true && polar.points.length) {
        const upper = polar.points.findIndex(p => p.twsKn >= s.sailingWindSpeedKn!)
        const a = polar.points[Math.max(0, upper < 0 ? polar.points.length - 1 : upper - 1)]!
        const b = polar.points[upper < 0 ? polar.points.length - 1 : upper]!
        const ratio = b.twsKn === a.twsKn ? 0 : Math.max(0, Math.min(1, (s.sailingWindSpeedKn - a.twsKn) / (b.twsKn - a.twsKn)))
        const angleKey = s.kind === 'tack' ? 'upwindTwaDeg' : 'downwindTwaDeg'
        const speedKey = s.kind === 'tack' ? 'upwindSpeedKn' : 'downwindSpeedKn'
        const targetAngle = a[angleKey] + ratio * (b[angleKey] - a[angleKey]), speed = a[speedKey] + ratio * (b[speedKey] - a[speedKey])
        if (finite(targetAngle) && targetAngle >= 20 && targetAngle <= 175 && finite(speed) && speed >= 0.5 && speed <= 80) { s.targetTwaDeg = targetAngle; s.targetSpeedKn = speed }
      }
    }
    this.result = s
    return structuredClone(s)
  }
}

/** Check freshness again at the consumer: polling must not refresh source age. */
export function guidanceBearings(s: GuidanceSnapshot | null | undefined, now: number, options: { legBearingDeg?: number | null; targetBearingDeg?: number | null } = {}): GuideBearings {
  const out: GuideBearings = { headingDeg: null, waterCourseDeg: null, currentCourseDeg: null, oppositeCourseDeg: null, oppositeHeadingDeg: null, trueWindFromDeg: null, trueWindSpeedKn: null, kind: null, currentTack: null, courseToSteerDeg: null, corrected: false, turning: false }
  if (!s || s.v !== 1 || s.algorithm !== GUIDANCE_ALGORITHM || !finite(s.headingDeg) || !finite(s.headingAt) || !finite(s.headingValidUntil)
    || now < s.headingAt - 1000 || now > s.headingValidUntil) return out
  out.headingDeg = s.headingDeg; out.turning = s.turning
  const leewayValid = finite(s.leewayDeg) && finite(s.leewayAt) && now >= s.leewayAt - 1000 && now <= s.leewayAt + (s.headingValidUntil - s.headingAt) && s.leewayBasis !== 'unavailable'
  if (leewayValid && !s.turning && !s.motionUnstable) out.waterCourseDeg = normalizeDegrees(s.headingDeg + s.leewayDeg!)
  const currentValid = s.currentValidUntil !== null && now <= s.currentValidUntil && finite(s.currentEastKn) && finite(s.currentNorthKn)
  const correctionValid = s.correctionValidUntil !== null && now <= s.correctionValidUntil && finite(s.waterSpeedKn) && s.waterSpeedKn >= 0.5
  const usePolar = finite(s.targetTwaDeg) && finite(s.targetSpeedKn) && s.targetSpeedKn >= 0.5
  const selected = s.sailingWindBasis !== undefined
  const windFrom = selected ? s.sailingWindFromDeg : currentValid && (correctionValid || usePolar) && finite(s.waterWindFromDeg) ? s.waterWindFromDeg : s.windFromDeg
  const windSpeed = selected ? s.sailingWindSpeedKn : currentValid && (correctionValid || usePolar) && finite(s.windFromDeg) && finite(s.windSpeedKn) ? Math.hypot(s.windSpeedKn * Math.sin(rad(s.windFromDeg)) + s.currentEastKn!, s.windSpeedKn * Math.cos(rad(s.windFromDeg)) + s.currentNorthKn!) : s.windSpeedKn
  const windAt = selected ? s.sailingWindAt : s.windAt, windUntil = selected ? s.sailingWindValidUntil : s.windValidUntil
  if (!finite(windFrom) || !finite(windSpeed) || windSpeed <= 0.1 || !finite(windAt) || !finite(windUntil) || now < windAt - 1000 || now > windUntil || !s.kind || !s.currentTack || s.turning) return out
  const leg = options.legBearingDeg
  if (finite(leg)) { const angle = Math.abs(signedDegrees(leg - windFrom)); if (s.kind === 'tack' ? angle >= 90 : angle <= 90) return out }
  const side = s.currentTack === 'starboard' ? 1 : -1
  const activeHeading = usePolar ? normalizeDegrees(windFrom - side * s.targetTwaDeg!) : s.headingDeg
  const opposite = usePolar ? normalizeDegrees(windFrom + side * s.targetTwaDeg!) : normalizeDegrees(2 * windFrom - s.headingDeg)
  const groundCourse = (heading: number, leeway: number | null): number | null => {
    const angle = leewayValid ? leeway ?? 0 : 0
    if (!correctionValid && !usePolar) return normalizeDegrees(heading + angle)
    const waterSpeed = usePolar ? s.targetSpeedKn! : s.waterSpeedKn! * Math.cos(rad(leewayValid ? s.leewayDeg! : 0)) / Math.cos(rad(angle))
    const water = vector(waterSpeed, heading + angle)
    const east = water[0] + (currentValid ? s.currentEastKn! : 0), north = water[1] + (currentValid ? s.currentNorthKn! : 0)
    return Math.hypot(east, north) >= 0.2 ? direction(east, north) : null
  }
  out.currentCourseDeg = groundCourse(activeHeading, s.leewayDeg); out.oppositeCourseDeg = groundCourse(opposite, s.oppositeLeewayDeg)
  out.oppositeHeadingDeg = opposite; out.trueWindFromDeg = windFrom; out.trueWindSpeedKn = windSpeed
  out.currentTack = s.currentTack; out.kind = s.kind; out.corrected = leewayValid || (correctionValid || usePolar) && currentValid
  const target = options.targetBearingDeg
  if (finite(target) && (correctionValid || usePolar) && currentValid) {
    const steeringSpeed = usePolar ? s.targetSpeedKn! : s.waterSpeedKn!
    const unit = vector(1, target), right = vector(1, target + 90)
    const cross = s.currentEastKn! * right[0] + s.currentNorthKn! * right[1]
    if (Math.abs(cross) < steeringSpeed) {
      const waterBearing = target - deg(Math.asin(cross / steeringSpeed))
      const forward = steeringSpeed * Math.cos(rad(waterBearing - target)) + s.currentEastKn! * unit[0] + s.currentNorthKn! * unit[1]
      const candidate = normalizeDegrees(waterBearing - (leewayValid ? s.leewayDeg! : 0)), targetTwa = Math.abs(signedDegrees(windFrom - candidate))
      const onSameTack = Math.sign(signedDegrees(windFrom - candidate)) === (s.currentTack === 'starboard' ? 1 : -1)
      if (forward > 0.2 && targetTwa >= 30 && targetTwa <= 175 && onSameTack) out.courseToSteerDeg = round(candidate)
    }
  }
  return out
}
