import type { VesselPerformance } from './sailing/physics'
import { buildOnboardPlan, type OnboardPlan } from './plan'
import { packValidityAt, racePackAppliesToCourse, type RacePack } from './pack'
import type { RacePackStore } from './race-pack-store'
import { type ObservationCollector } from './observations'
import type { OnboardPlanSnapshot, OnboardSnapshotStore } from './onboard-store'

export type CalculationAuthority = 'cloud' | 'onboard'

export type OnboardAvailabilityReason =
  | 'cloud_authority'
  | 'no_race_pack'
  | 'no_active_course'
  | 'pack_not_applicable'
  | 'pack_expired'
  | 'not_racing'
  | 'insufficient_observations'
  | 'no_current_position'
  | 'reverse_course_unsupported'
  | 'recent_calculation'

export interface OnboardCourseState {
  courseId: string
  racePlanId: number | null
  courseDefinitionDigest: string | null
  activeIndex: number
  totalPoints: number
  reverse: boolean
}

export interface OnboardRaceServiceOptions {
  packs: RacePackStore
  snapshots: OnboardSnapshotStore
  observations: ObservationCollector
  course: () => OnboardCourseState | null
  racing: () => boolean
  now?: () => number
  cadenceMs?: number
  vessel?: () => VesselPerformance | null
  onCalculated?: (snapshot: OnboardPlanSnapshot) => void
}

const DEFAULT_CADENCE_MS = 15 * 60 * 1000

// The pack carries camelCase vessel performance; the planner uses the internal
// snake_case VesselPerformance shape. Prefer the pack's synchronised values over
// any local config so cloud and onboard fall back identically.
export function vesselPerformanceFromPack(pack: RacePack): VesselPerformance | null {
  const performance = pack.vesselPerformance
  if (!performance) return null
  return {
    hull_speed_knots: performance.hullSpeedKnots ?? null,
    length_waterline_m: performance.lengthWaterlineM ?? null,
    length_m: performance.lengthM ?? null
  }
}

export class OnboardRaceService {
  private authority: CalculationAuthority = 'cloud'
  private timer?: NodeJS.Timeout
  private lastCalculationAt: number | null = null
  private lastReason: OnboardAvailabilityReason | null = null
  private lastPlan: OnboardPlan | null = null
  private lastWarning: string | null = null
  private closed = false
  private readonly now: () => number
  private readonly cadenceMs: number

  constructor(private readonly options: OnboardRaceServiceOptions) {
    this.now = options.now ?? Date.now
    this.cadenceMs = options.cadenceMs ?? DEFAULT_CADENCE_MS
  }

  get calculationAuthority(): CalculationAuthority { return this.authority }

  async setAuthority(uploadMode: 'automatic' | 'local_only'): Promise<void> {
    if (this.closed) return
    const next: CalculationAuthority = uploadMode === 'local_only' ? 'onboard' : 'cloud'
    if (next === this.authority) {
      if (next === 'onboard') this.schedule()
      return
    }
    this.authority = next
    if (next === 'cloud') {
      // Switching back to cloud authority stops the onboard scheduler but
      // retains the cached pack and every historical snapshot.
      this.clearTimer()
      return
    }
    // automatic -> local_only transfers authority immediately: calculate now
    // when the pack and observations already allow it, then resume the cadence.
    await this.refresh(true)
    this.schedule()
  }

  async refresh(force = false): Promise<OnboardPlanSnapshot | null> {
    if (this.closed) return null
    const availability = this.availability(force)
    if (!availability.ok) {
      this.lastReason = availability.reason
      return null
    }
    const pack = availability.pack
    const course = availability.course
    const now = this.now()
    const observations = this.options.observations.observations(now)
    const packApplied = this.options.packs.applied()
    let plan: OnboardPlan
    try {
      plan = buildOnboardPlan({
        pack,
        activeIndex: course.activeIndex,
        // Only a complete, fresh observation window may drive the current leg;
        // otherwise the planner falls back to that leg's downloaded forecast.
        averages: observations.readiness.ready ? observations.averages : null,
        position: observations.position ? { latitude: observations.position.latitude, longitude: observations.position.longitude } : null,
        now,
        vessel: vesselPerformanceFromPack(pack) ?? this.options.vessel?.() ?? null
      })
    } catch {
      this.lastReason = 'insufficient_observations'
      return null
    }
    const snapshot: OnboardPlanSnapshot = {
      v: 1,
      kind: 'race_plan_snapshot',
      id: `${packApplied?.packId ?? 'pack'}:${pack.revision}:${now}`,
      generatedAt: now,
      source: 'onboard',
      packId: packApplied?.packId ?? pack.packId ?? null,
      packRevision: pack.revision,
      packSha256: packApplied?.sha256 ?? '',
      ruleSetVersion: pack.ruleSetVersion,
      tracking: { courseId: course.courseId, racePlanId: course.racePlanId, activeIndex: course.activeIndex, totalPoints: course.totalPoints, reverse: course.reverse },
      observations: observations.averages,
      position: observations.position ? { latitude: observations.position.latitude, longitude: observations.position.longitude } : null,
      activeLegSequence: plan.activeLegSequence,
      completedLegCount: plan.completedLegCount,
      estimatedFinishAt: plan.estimatedFinishAt,
      remainingDurationSeconds: plan.remainingDurationSeconds,
      legCount: plan.legs.length,
      forecastCoverage: plan.forecastCoverage,
      warning: plan.warnings[0] ?? null,
      plan
    }
    try {
      await this.options.snapshots.append(snapshot, now)
    } catch {
      this.lastReason = 'insufficient_observations'
      return null
    }
    this.lastCalculationAt = now
    this.lastPlan = plan
    // A partial-coverage plan is still persisted (so current observed
    // conditions remain visible) but is flagged rather than silently stale.
    this.lastReason = null
    this.lastWarning = plan.warnings[0] ?? null
    try { this.options.onCalculated?.(snapshot) } catch { /* never let a listener break the scheduler */ }
    return snapshot
  }

  availability(force = false): { ok: true; pack: RacePack; course: OnboardCourseState } | { ok: false; reason: OnboardAvailabilityReason } {
    if (this.authority !== 'onboard') return { ok: false, reason: 'cloud_authority' }
    const pack = this.options.packs.current()
    if (!pack) return { ok: false, reason: 'no_race_pack' }
    const course = this.options.course()
    if (!course) return { ok: false, reason: 'no_active_course' }
    // Reverse-order courses are not supported by the v1 onboard rule set. Fail
    // closed rather than silently calculating the course forwards.
    if (course.reverse) return { ok: false, reason: 'reverse_course_unsupported' }
    if (!racePackAppliesToCourse(pack, course)) return { ok: false, reason: 'pack_not_applicable' }
    if (packValidityAt(pack, this.now()) === 'expired') return { ok: false, reason: 'pack_expired' }
    if (!this.options.racing()) return { ok: false, reason: 'not_racing' }
    const observations = this.options.observations.observations(this.now())
    // An active-race calculation requires a real current position; the planner
    // never fabricates one.
    if (!observations.position) return { ok: false, reason: 'no_current_position' }
    // Forecast-only planning is allowed: a valid pack should not simply
    // disappear because observations are not ready yet. A pack with no usable
    // forecast still needs a complete observation window.
    const hasForecast = pack.forecast.legs.some((leg) => leg.samples.length > 0)
    if (!observations.readiness.ready && !hasForecast) return { ok: false, reason: 'insufficient_observations' }
    if (!force && this.lastCalculationAt !== null && this.now() - this.lastCalculationAt < this.cadenceMs) return { ok: false, reason: 'recent_calculation' }
    return { ok: true, pack, course }
  }

  currentPlan(): OnboardPlan | null { return this.lastPlan ?? null }

  status(): object {
    const pack = this.options.packs.current()
    const applied = this.options.packs.applied()
    const course = this.options.course()
    const observations = this.options.observations.observations(this.now())
    const reason = this.lastReason
    return {
      calculationAuthority: this.authority,
      lastLocalCalculationAt: this.lastCalculationAt,
      reason,
      warning: this.lastWarning,
      forecastCoverage: this.lastPlan?.forecastCoverage ?? null,
      warnings: this.lastPlan?.warnings ?? [],
      observationsReady: observations.readiness.ready,
      observationReadiness: observations.readiness,
      cadenceSeconds: Math.round(this.cadenceMs / 1000),
      pack: applied ? {
        available: true,
        packId: applied.packId,
        revision: applied.revision,
        sha256: applied.sha256,
        ruleSetVersion: applied.ruleSetVersion,
        courseId: applied.courseId,
        racePlanId: applied.racePlanId,
        courseDefinitionDigest: applied.courseDefinitionDigest,
        generatedAt: applied.generatedAt,
        validFrom: applied.validFrom,
        validUntil: applied.validUntil,
        appliedAt: applied.appliedAt,
        applicable: pack ? racePackAppliesToCourse(pack, course) : false,
        currentAt: pack ? packValidityAt(pack, this.now()) : 'unknown'
      } : { available: false, packId: null, revision: null, sha256: null, ruleSetVersion: null, courseId: null, racePlanId: null, courseDefinitionDigest: null, generatedAt: null, validFrom: null, validUntil: null, appliedAt: null, applicable: false, currentAt: 'unknown' },
      observations: {
        sampleCount: observations.averages.sampleCount,
        windowSeconds: observations.averages.windowSeconds,
        windSource: observations.averages.windSource,
        twsKnots: observations.averages.twsKnots,
        twdDeg: observations.averages.twdDeg,
        position: observations.position ? { latitude: observations.position.latitude, longitude: observations.position.longitude } : null,
        lastUpdateAt: observations.lastUpdateAt
      }
    }
  }

  close(): void { this.closed = true; this.clearTimer() }

  private schedule(): void {
    this.clearTimer()
    if (this.closed || this.authority !== 'onboard') return
    const now = this.now()
    const base = this.lastCalculationAt ?? now
    const delay = Math.max(1000, this.cadenceMs - Math.max(0, now - base))
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh(false).finally(() => this.schedule())
    }, delay)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
