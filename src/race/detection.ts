const EARTH_RADIUS_M = 6_371_000
const DEG = Math.PI / 180

export type Rounding = 'port' | 'starboard' | 'either'
export type PointKind = 'start' | 'mark' | 'gate' | 'finish'

export interface CourseProgressPoint {
  latitude: number
  longitude: number
  name?: string
  kind?: PointKind
  rounding?: Rounding
}

export interface ProgressFix {
  at: number
  latitude: number
  longitude: number
  sogKn?: number | null
  cogDeg?: number | null
  accuracyM?: number | null
}

export interface ProgressionConfig {
  minSogKn: number
  captureRadiusM: number
  maxAccuracyM: number
}

export const DEFAULT_PROGRESSION_CONFIG: ProgressionConfig = { minSogKn: 1, captureRadiusM: 75, maxAccuracyM: 25 }

export interface ProgressionDetection {
  type: 'start' | 'rounding' | 'finish'
  pointIndex: number
  at: number
  confidence: 'high' | 'medium'
  passedSide?: 'port' | 'starboard'
  wrongSide: boolean
  distanceM: number
  sogKn?: number | null
  revision: number
}

interface Vector { x: number; y: number }

function radians(value: number): number { return value * DEG }

function project(latitude: number, longitude: number, originLatitude: number): Vector {
  return { x: radians(longitude) * Math.cos(radians(originLatitude)) * EARTH_RADIUS_M, y: radians(latitude) * EARTH_RADIUS_M }
}

export function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const dLat = radians(b.latitude - a.latitude)
  const dLon = radians(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

export function bearingDeg(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const dLon = radians(b.longitude - a.longitude)
  const y = Math.sin(dLon) * Math.cos(radians(b.latitude))
  const x = Math.cos(radians(a.latitude)) * Math.sin(radians(b.latitude)) - Math.sin(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.cos(dLon)
  return (Math.atan2(y, x) / DEG + 360) % 360
}

function bearingVector(bearing: number): Vector {
  return { x: Math.sin(radians(bearing)), y: Math.cos(radians(bearing)) }
}

function dot(a: Vector | { x: number; y: number }, b: Vector | { x: number; y: number }): number {
  return a.x * b.x + a.y * b.y
}

function crossingHeadingDot(headingDeg: number, bearing: number): number {
  const a = radians(headingDeg)
  const b = radians(bearing)
  return Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b)
}

interface PointState {
  previousAlong: number | null
  previousLateral: number | null
  previousFix: ProgressFix | null
  minDistanceM: number
  emitted: boolean
}

export class RaceProgressionDetector {
  private points: Array<CourseProgressPoint & { rounding: Rounding }> = []
  private revision = 0
  private index = 0
  private state: PointState = freshState()
  private pending: ProgressionDetection | null = null

  constructor(private readonly config: ProgressionConfig = DEFAULT_PROGRESSION_CONFIG) {}

  get activeIndex(): number { return this.index }
  get currentRevision(): number { return this.revision }
  get pendingDetection(): ProgressionDetection | null { return this.pending }

  setCourse(revision: number, points: CourseProgressPoint[], reverse = false, activeIndex = 1): void {
    const normalized = points.map((point, position) => ({
      ...point,
      kind: point.kind ?? (position === 0 ? 'start' as const : position === points.length - 1 ? 'finish' as const : 'mark' as const),
      rounding: point.rounding ?? 'either' as const
    }))
    this.points = reverse
      ? normalized.reverse().map((point) => ({ ...point, rounding: point.rounding === 'port' ? 'starboard' as const : point.rounding === 'starboard' ? 'port' as const : point.rounding }))
      : normalized
    this.revision = revision
    this.index = Math.min(Math.max(activeIndex, 0), Math.max(this.points.length - 1, 0))
    this.state = freshState()
    this.pending = null
  }

  setActiveIndex(index: number): void {
    this.index = Math.min(Math.max(index, 0), Math.max(this.points.length - 1, 0))
    this.state = freshState()
    this.pending = null
  }

  accept(): void {
    this.pending = null
    if (this.index < this.points.length - 1) this.setActiveIndex(this.index + 1)
    else this.state = freshState()
  }

  dismiss(): void {
    this.pending = null
    this.state = { ...freshState(), previousAlong: this.state.previousAlong, previousLateral: this.state.previousLateral, previousFix: this.state.previousFix, minDistanceM: this.state.minDistanceM }
  }

  fix(fix: ProgressFix): ProgressionDetection | null {
    if (this.points.length < 2 || this.state.emitted) return null
    if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude) || !Number.isFinite(fix.at)) return null
    if (this.config.captureRadiusM <= 0) return null
    if (fix.sogKn == null || fix.sogKn < this.config.minSogKn) return null
    if (fix.accuracyM != null && fix.accuracyM > this.config.maxAccuracyM) return null

    const index = this.index
    const point = this.points[index]
    if (!point) return null
    const origin = point
    const mark = project(point.latitude, point.longitude, origin.latitude)
    const active = project(fix.latitude, fix.longitude, origin.latitude)
    const approachBearing = index === 0 ? bearingDeg(point, this.points[1]!) : bearingDeg(this.points[index - 1]!, point)
    const approach = bearingVector(approachBearing)
    const offset = { x: active.x - mark.x, y: active.y - mark.y }
    const along = dot(approach, offset)
    const lateral = approach.x * offset.y - approach.y * offset.x
    const distance = distanceM(fix, point)

    const previous = this.state.previousFix
    this.state.minDistanceM = Math.min(this.state.minDistanceM, distance)

    if (previous && this.state.previousAlong != null && this.state.previousAlong < 0 && along >= 0) {
      const span = along - this.state.previousAlong
      const ratio = span > 0 ? -this.state.previousAlong / span : 1
      const lateralAtCrossing = (this.state.previousLateral ?? 0) + (lateral - (this.state.previousLateral ?? 0)) * ratio
      const crossingHeading = bearingDeg(previous, fix)
      const exitBearing = index === this.points.length - 1 ? approachBearing : bearingDeg(point, this.points[index + 1]!)
      const forward = index === this.points.length - 1 || index === 0
        ? crossingHeadingDot(crossingHeading, exitBearing) > 0
        : crossingHeadingDot(crossingHeading, exitBearing) >= -0.2
      if (forward && Math.min(this.state.minDistanceM, Math.abs(lateralAtCrossing)) <= this.config.captureRadiusM) {
        const passedSide = lateralAtCrossing > 0 ? 'starboard' as const : 'port' as const
        const expected = point.rounding === 'either' ? null : point.rounding
        const wrongSide = expected !== null && expected !== passedSide
        const detection: ProgressionDetection = {
          type: point.kind === 'start' ? 'start' : point.kind === 'finish' ? 'finish' : 'rounding',
          pointIndex: index,
          at: crossingTime(previous.at, fix.at, ratio),
          confidence: wrongSide ? 'medium' : 'high',
          passedSide,
          wrongSide,
          distanceM: Math.round(Math.min(this.state.minDistanceM, Math.abs(lateralAtCrossing)) * 10) / 10,
          sogKn: fix.sogKn ?? null,
          revision: this.revision
        }
        this.state.emitted = true
        this.state.previousAlong = along
        this.state.previousLateral = lateral
        this.state.previousFix = fix
        this.pending = detection
        return detection
      }
    }

    this.state.previousAlong = along
    this.state.previousLateral = lateral
    this.state.previousFix = fix
    return null
  }
}

function freshState(): PointState {
  return { previousAlong: null, previousLateral: null, previousFix: null, minDistanceM: Number.POSITIVE_INFINITY, emitted: false }
}

function crossingTime(previousAt: number, at: number, ratio: number): number {
  return Math.round(previousAt + (at - previousAt) * ratio)
}