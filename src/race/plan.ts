import { computeDynamicPlan, type DynamicObservedWind, type DynamicPlan, type DynamicPlanConditions, type DynamicPlanLeg } from './dynamic'
import type { SailingAverages } from './averages'
import type { VesselPerformance } from './sailing/physics'
import type { RacePack } from './pack'

export type { DynamicPlanConditions as OnboardPlanConditions, DynamicPlanLeg as OnboardPlanLeg }

// The onboard plan is the deterministic dynamic plan plus the observed sailing
// window that produced it (retained for the snapshot/status surface).
export type OnboardPlan = DynamicPlan & { observed: SailingAverages | null }

export interface OnboardPlanOptions {
  pack: RacePack
  activeIndex: number
  averages: SailingAverages | null
  now: number
  /** Latest valid vessel position. Required for a live/active-race calculation. */
  position?: { latitude: number; longitude: number } | null
  vessel?: VesselPerformance | null
}

export function buildOnboardPlan(options: OnboardPlanOptions): OnboardPlan {
  const observed: DynamicObservedWind | null = options.averages
    ? {
        twsKnots: options.averages.twsKnots,
        twdDeg: options.averages.twdDeg,
        gustKnots: options.averages.gustKnots ?? null,
        sampleCount: options.averages.sampleCount,
        spanSeconds: options.averages.windowSeconds,
        windSource: options.averages.windSource
      }
    : null
  const plan = computeDynamicPlan({
    v: 1,
    ruleSetVersion: options.pack.ruleSetVersion,
    now: options.now,
    activeIndex: options.activeIndex,
    reverse: false,
    courseId: options.pack.course.courseId,
    racePlanId: options.pack.racePlanId ?? options.pack.course.racePlanId ?? null,
    courseDefinitionDigest: options.pack.courseDefinitionDigest ?? null,
    packId: options.pack.packId ?? null,
    packRevision: options.pack.revision,
    points: options.pack.course.points,
    sails: options.pack.sails,
    raceHeadsail: options.pack.raceHeadsail ?? null,
    payload: options.pack.payload,
    vesselPerformance: options.vessel
      ? {
          hullSpeedKnots: options.vessel.hull_speed_knots ?? null,
          lengthWaterlineM: options.vessel.length_waterline_m ?? null,
          lengthM: options.vessel.length_m ?? null
        }
      : null,
    polarSummary: options.pack.polarSummary ?? null,
    forecast: options.pack.forecast,
    position: options.position ?? null,
    observed
  })
  return { ...plan, observed: options.averages }
}
