// Deterministic `race_plan_dynamic_v1` calculation core.
//
// This module is the single source of truth for the onboard rule set and is
// mirrored field-for-field (and rounding-for-rounding) by the Wake Logger cloud
// implementation in `api/app/services/race_plan_dynamic.py`. The shared golden
// fixture plus the cross-repo harness prove the two engines stay equivalent.
//
// The engine is a pure function over plain JSON: the plugin adapts a validated
// `RacePack` into `DynamicPlanInput`, and the cross-repo harness feeds the very
// same JSON document to both engines.

import {
  angularDifferenceDegrees,
  apparentWind,
  bearingDegrees,
  classifyPointOfSail,
  currentComponents,
  distanceNm,
  estimateBoatSpeedKnots,
  polarSpeedForLeg,
  signedAngleDegrees,
  type PolarSummary,
  type VesselPerformance
} from './sailing/physics'
import { buildRecommendedSailPlan, recommendSails, reefingRecommendation, type SailInventoryItem } from './sailing/selection'
import type {
  PackCoursePoint,
  PackForecastSample,
  PackLegForecast,
  RacePackPayload,
  RacePackRaceHeadsail,
  RacePackVesselPerformance
} from './pack'

export const DYNAMIC_RULE_SET_VERSION = 'race_plan_dynamic_v1'
// Bounded midpoint refinement. The provisional midpoint is re-derived from the
// selected sample's conditions at most this many times before the last result
// is used. There is no unbounded loop and no cross-leg weather substitution.
export const MAX_MIDPOINT_ITERATIONS = 3
// Both engines clamp estimated SOG to this floor so adverse current can never
// produce a zero/negative duration.
export const MIN_ESTIMATED_SOG_KNOTS = 0.5
// Timing fallback when no usable wind exists for a leg. Matches the historical
// onboard behaviour and the cloud engine.
export const TIMING_FALLBACK_SPEED_KNOTS = 5
export const MAX_FORECAST_EXTRAPOLATION_MS = 6 * 60 * 60 * 1000

const MILLISECONDS_PER_HOUR = 3_600_000

export interface DynamicObservedWind {
  twsKnots: number | null
  twdDeg: number | null
  gustKnots?: number | null
  sampleCount?: number | null
  spanSeconds?: number | null
  windSource?: string | null
}

export interface DynamicPlanInput {
  v: 1
  ruleSetVersion: string
  now: number
  activeIndex: number
  reverse: boolean
  courseId: string
  racePlanId: number | null
  courseDefinitionDigest: string | null
  packId: string | null
  packRevision: number
  points: PackCoursePoint[]
  sails: SailInventoryItem[]
  raceHeadsail: RacePackRaceHeadsail | null
  payload: RacePackPayload
  /** Race Pack camelCase vessel performance; mapped to snake_case internally. */
  vesselPerformance: RacePackVesselPerformance | null
  polarSummary: PolarSummary | null
  forecast: { legs: PackLegForecast[] }
  position: { latitude: number; longitude: number } | null
  observed: DynamicObservedWind | null
}

export interface DynamicPlanConditions {
  source: 'observed' | 'forecast'
  twsKnots: number | null
  twdDeg: number | null
  gustKnots: number | null
  waveHeightM: number | null
  waveDirectionDeg: number | null
  currentVelocityKn: number | null
  currentDirectionDeg: number | null
  sampleTime: string | null
  forecastCoverage: 'within' | 'out_of_range' | null
}

export interface DynamicPlanLeg {
  sequence: number
  from: { name: string; latitude: number; longitude: number }
  to: { name: string; latitude: number; longitude: number }
  /** True when the leg starts from the live vessel position rather than a mark. */
  fromVesselPosition: boolean
  /** The full mark-to-mark leg distance, independent of vessel progress. */
  markToMarkDistanceNm: number
  distanceNm: number
  bearingDeg: number
  twaDeg: number | null
  pointOfSail: string | null
  windSide: 'port' | 'starboard' | null
  estimatedSpeedKnots: number | null
  polarSpeedKnots: number | null
  /** Boat/polar speed plus the along-leg current component, clamped to the SOG floor. */
  estimatedSogKnots: number | null
  /** Signed along-leg current component in knots (positive pushes toward the mark). */
  currentComponentKnots: number | null
  estimatedBoatSpeedKnots: number | null
  legDurationSeconds: number | null
  midpointEta: string | null
  selectedForecastSampleTime: string | null
  conditions: DynamicPlanConditions
  plan: Record<string, unknown> | null
}

export interface DynamicPlan {
  v: 1
  generatedAt: string
  packId: string | null
  packRevision: number
  ruleSetVersion: string
  courseId: string
  racePlanId: number | null
  courseDefinitionDigest: string | null
  activeLegSequence: number | null
  completedLegCount: number
  estimatedFinishAt: string | null
  remainingDurationSeconds: number | null
  forecastCoverage: 'complete' | 'partial'
  warnings: string[]
  legs: DynamicPlanLeg[]
}

interface LegSpeed {
  speed: number | null
  polarSpeed: number | null
  warnings: string[]
}

function observedConditions(observed: DynamicObservedWind, sample: PackForecastSample | null): DynamicPlanConditions {
  return {
    source: 'observed',
    twsKnots: observed.twsKnots,
    twdDeg: observed.twdDeg,
    gustKnots: observed.gustKnots ?? observed.twsKnots,
    waveHeightM: sample?.wave_height_m ?? null,
    waveDirectionDeg: sample?.wave_direction_deg ?? null,
    currentVelocityKn: sample?.current_velocity_kn ?? null,
    currentDirectionDeg: sample?.current_direction_deg ?? null,
    sampleTime: sample?.time ?? null,
    forecastCoverage: sample ? 'within' : null
  }
}

function outOfCoverageConditions(): DynamicPlanConditions {
  return { source: 'forecast', twsKnots: null, twdDeg: null, gustKnots: null, waveHeightM: null, waveDirectionDeg: null, currentVelocityKn: null, currentDirectionDeg: null, sampleTime: null, forecastCoverage: 'out_of_range' }
}

function forecastConditions(sample: PackForecastSample): DynamicPlanConditions {
  return {
    source: 'forecast',
    twsKnots: sample.tws_knots,
    twdDeg: sample.twd_deg,
    gustKnots: sample.gust_knots ?? null,
    waveHeightM: sample.wave_height_m ?? null,
    waveDirectionDeg: sample.wave_direction_deg ?? null,
    currentVelocityKn: sample.current_velocity_kn ?? null,
    currentDirectionDeg: sample.current_direction_deg ?? null,
    sampleTime: sample.time,
    forecastCoverage: 'within'
  }
}

// Select the sample nearest `targetAt`; ties break to the earlier sample. This
// is the frozen temporal rule for `race_plan_dynamic_v1`.
export function selectSampleForEta(samples: PackForecastSample[], targetAt: number): PackForecastSample | null {
  let best: PackForecastSample | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const sample of samples) {
    const at = Date.parse(sample.time)
    const delta = Number.isFinite(at) ? Math.abs(at - targetAt) : Number.POSITIVE_INFINITY
    if (delta < bestDelta) {
      best = sample
      bestDelta = delta
    }
  }
  return best
}

function conditionsAt(series: PackLegForecast | undefined, targetAt: number, useObserved: boolean, observed: DynamicObservedWind | null): DynamicPlanConditions {
  const sample = series ? selectSampleForEta(series.samples, targetAt) : null
  if (!sample) return outOfCoverageConditions()
  const delta = Math.abs(Date.parse(sample.time) - targetAt)
  if (!Number.isFinite(delta) || delta > MAX_FORECAST_EXTRAPOLATION_MS) return outOfCoverageConditions()
  return useObserved && observed ? observedConditions(observed, sample) : forecastConditions(sample)
}

function twaFor(conditions: DynamicPlanConditions, bearing: number): number | null {
  return conditions.twsKnots !== null && conditions.twdDeg !== null ? angularDifferenceDegrees(bearing, conditions.twdDeg) : null
}

function pointOfSailFor(conditions: DynamicPlanConditions, bearing: number): string | null {
  const twa = twaFor(conditions, bearing)
  return twa === null ? null : classifyPointOfSail(twa)
}

function windSideFor(conditions: DynamicPlanConditions, bearing: number): 'port' | 'starboard' | null {
  return conditions.twdDeg !== null ? (signedAngleDegrees(conditions.twdDeg, bearing) > 0 ? 'starboard' : 'port') : null
}

function currentFor(conditions: DynamicPlanConditions, bearing: number): number {
  return currentComponents({ currentVelocityKn: conditions.currentVelocityKn, currentDirectionDeg: conditions.currentDirectionDeg, legBearingDeg: bearing }).estimatedSogDeltaKn
}

function legSpeed(
  vessel: VesselPerformance,
  polarSummary: PolarSummary | null,
  conditions: DynamicPlanConditions,
  bearing: number
): LegSpeed {
  const pointOfSail = pointOfSailFor(conditions, bearing)
  if (pointOfSail === null || conditions.twsKnots === null) return { speed: null, polarSpeed: null, warnings: [] }
  const tws = conditions.twsKnots
  const gust = conditions.gustKnots ?? tws
  const [estimated, speedWarnings] = estimateBoatSpeedKnots({ vessel, pointOfSail, forecastTwsKnots: tws, forecastGustKnots: gust })
  const [polar] = polarSpeedForLeg(polarSummary, { twaDeg: twaFor(conditions, bearing) ?? 0, forecastTwsKnots: tws, windSide: windSideFor(conditions, bearing) })
  // Fallback order: usable polar, then vessel-specific performance, then the
  // documented generic hull-speed fallback (which carries a warning).
  if (polar !== null && polar !== undefined) return { speed: polar, polarSpeed: polar, warnings: [] }
  return { speed: estimated, polarSpeed: polar ?? null, warnings: speedWarnings }
}

export function computeDynamicPlan(input: DynamicPlanInput): DynamicPlan {
  const points = input.points
  const lastIndex = points.length - 1
  const firstIndex = Math.min(Math.max(input.activeIndex, 1), lastIndex)
  const forecastByLeg = new Map<number, PackLegForecast>()
  for (const leg of input.forecast.legs) forecastByLeg.set(leg.sequence, leg)
  const raceHeadsailId = input.raceHeadsail && Number.isSafeInteger(input.raceHeadsail.sail_id) ? input.raceHeadsail.sail_id : null
  const availableCrewCount = typeof input.payload.availableCrewCount === 'number' ? input.payload.availableCrewCount : null
  const performance = input.vesselPerformance
  const vessel: VesselPerformance = {
    hull_speed_knots: performance?.hullSpeedKnots ?? null,
    length_waterline_m: performance?.lengthWaterlineM ?? null,
    length_m: performance?.lengthM ?? null
  }
  const warnings: string[] = []
  const legs: DynamicPlanLeg[] = []
  let partialCoverage = false
  let cursor = input.now

  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const markFrom = points[index - 1]!
    const to = points[index]!
    const markDistance = distanceNm(markFrom.latitude, markFrom.longitude, to.latitude, to.longitude)
    const useVessel = index === firstIndex && input.position !== null
    const from = useVessel
      ? { name: 'Current position', latitude: input.position!.latitude, longitude: input.position!.longitude }
      : { name: markFrom.name, latitude: markFrom.latitude, longitude: markFrom.longitude }
    const distance = distanceNm(from.latitude, from.longitude, to.latitude, to.longitude)
    const bearing = bearingDegrees(from.latitude, from.longitude, to.latitude, to.longitude)
    const useObserved = index === firstIndex && input.observed !== null

    // Bounded midpoint refinement. Start from the conditions at the leg start,
    // re-select at each provisional midpoint and stop as soon as the selected
    // sample is stable (or after MAX_MIDPOINT_ITERATIONS).
    let conditions = conditionsAt(forecastByLeg.get(index), cursor, useObserved, input.observed)
    let speed = legSpeed(vessel, input.polarSummary, conditions, bearing)
    for (let iteration = 0; iteration < MAX_MIDPOINT_ITERATIONS; iteration += 1) {
      const provisionalSpeed = speed.speed ?? TIMING_FALLBACK_SPEED_KNOTS
      const provisionalSog = Math.max(MIN_ESTIMATED_SOG_KNOTS, provisionalSpeed + currentFor(conditions, bearing))
      const duration = distance / provisionalSog
      const midpoint = cursor + (duration * MILLISECONDS_PER_HOUR) / 2
      const next = conditionsAt(forecastByLeg.get(index), midpoint, useObserved, input.observed)
      const stable = next.sampleTime === conditions.sampleTime && next.source === conditions.source
      conditions = next
      speed = legSpeed(vessel, input.polarSummary, conditions, bearing)
      if (stable) break
    }

    if (conditions.forecastCoverage === 'out_of_range') {
      partialCoverage = true
      warnings.push(`Leg ${index} forecast does not cover the recalculated time`)
    }
    if (index === firstIndex && conditions.source === 'forecast' && input.observed === null) {
      warnings.push('Fresh onboard observations not yet available')
    }
    const twa = twaFor(conditions, bearing)
    const pointOfSail = conditions.twsKnots !== null && conditions.twdDeg !== null ? classifyPointOfSail(twa ?? 0) : null
    const windSide = windSideFor(conditions, bearing)
    const current = currentComponents({ currentVelocityKn: conditions.currentVelocityKn, currentDirectionDeg: conditions.currentDirectionDeg, legBearingDeg: bearing })
    const speedForTiming = speed.speed ?? TIMING_FALLBACK_SPEED_KNOTS
    const estimatedSog = conditions.twsKnots === null ? null : Math.max(MIN_ESTIMATED_SOG_KNOTS, speedForTiming + current.estimatedSogDeltaKn)
    const durationHours = distance / (estimatedSog ?? speedForTiming)
    const midpoint = cursor + (durationHours * MILLISECONDS_PER_HOUR) / 2
    for (const warning of speed.warnings) warnings.push(`Leg ${index}: ${warning}`)

    let plan: Record<string, unknown> | null = null
    if (pointOfSail !== null && conditions.twsKnots !== null && conditions.twdDeg !== null) {
      const gust = conditions.gustKnots ?? conditions.twsKnots
      const apparent = apparentWind({ vesselCourseDeg: bearing, vesselSpeedKnots: speed.speed ?? 0, trueWindFromDeg: conditions.twdDeg, trueWindSpeedKnots: conditions.twsKnots })
      const apparentGust = apparentWind({ vesselCourseDeg: bearing, vesselSpeedKnots: speed.speed ?? 0, trueWindFromDeg: conditions.twdDeg, trueWindSpeedKnots: gust })
      const [candidates] = recommendSails(input.sails, {
        point_of_sail: pointOfSail,
        twa_deg: twa ?? 0,
        forecast_tws_knots: conditions.twsKnots,
        forecast_gust_knots: gust,
        awa_deg: apparent.awaDeg,
        aws_knots: apparent.awsKnots,
        apparent_gust_knots: apparentGust.awsKnots,
        available_crew_count: availableCrewCount
      })
      const fixedHeadsailCandidate = raceHeadsailId !== null ? candidates.find((candidate) => candidate.sail_id === raceHeadsailId) ?? null : null
      plan = buildRecommendedSailPlan({
        candidates,
        reefing: reefingRecommendation(input.sails, { forecastTwsKnots: conditions.twsKnots, forecastGustKnots: gust }),
        pointOfSail,
        forecastTwsKnots: conditions.twsKnots,
        forecastGustKnots: gust,
        availableCrewCount,
        raceHeadsail: raceHeadsailId !== null ? { sail_id: raceHeadsailId, sail_name: input.raceHeadsail?.sail_name ?? null } : null,
        fixedHeadsailCandidate,
        jibChangesAllowed: input.payload.jibChangesAllowed === true
      })
    }

    legs.push({
      sequence: index,
      from,
      to: { name: to.name, latitude: to.latitude, longitude: to.longitude },
      fromVesselPosition: useVessel,
      markToMarkDistanceNm: markDistance,
      distanceNm: distance,
      bearingDeg: bearing,
      twaDeg: twa === null ? null : Math.round(twa * 10) / 10,
      pointOfSail,
      windSide,
      estimatedSpeedKnots: speed.speed,
      polarSpeedKnots: speed.polarSpeed,
      estimatedSogKnots: estimatedSog,
      currentComponentKnots: current.currentAlongLegKn,
      estimatedBoatSpeedKnots: speed.speed,
      legDurationSeconds: Math.round(durationHours * 3600),
      midpointEta: new Date(midpoint).toISOString(),
      selectedForecastSampleTime: conditions.sampleTime,
      conditions,
      plan
    })
    cursor += durationHours * MILLISECONDS_PER_HOUR
  }

  return {
    v: 1,
    generatedAt: new Date(input.now).toISOString(),
    packId: input.packId,
    packRevision: input.packRevision,
    ruleSetVersion: input.ruleSetVersion,
    courseId: input.courseId,
    racePlanId: input.racePlanId,
    courseDefinitionDigest: input.courseDefinitionDigest,
    activeLegSequence: legs.length ? firstIndex : null,
    completedLegCount: Math.max(0, firstIndex - 1),
    estimatedFinishAt: legs.length ? new Date(cursor).toISOString() : null,
    remainingDurationSeconds: legs.length ? Math.max(0, Math.round((cursor - input.now) / 1000)) : null,
    forecastCoverage: partialCoverage ? 'partial' : 'complete',
    warnings: [...new Set(warnings)],
    legs
  }
}
