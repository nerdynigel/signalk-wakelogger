import { angularDifferenceDegrees, apparentWind, bearingDegrees, classifyPointOfSail, distanceNm, estimateBoatSpeedKnots, polarSpeedForLeg, signedAngleDegrees, type VesselPerformance } from './sailing/physics'
import { buildRecommendedSailPlan, recommendSails, reefingRecommendation } from './sailing/selection'
import type { RacePack } from './pack'
import type { SailingAverages } from './averages'

export interface OnboardPlanConditions {
  source: 'observed' | 'forecast'
  twsKnots: number | null
  twdDeg: number | null
  gustKnots: number | null
  waveHeightM: number | null
  waveDirectionDeg: number | null
  currentVelocityKn: number | null
  currentDirectionDeg: number | null
  sampleTime: string | null
}

export interface OnboardPlanLeg {
  sequence: number
  from: { name: string; latitude: number; longitude: number }
  to: { name: string; latitude: number; longitude: number }
  distanceNm: number
  bearingDeg: number
  twaDeg: number | null
  pointOfSail: string | null
  windSide: 'port' | 'starboard' | null
  estimatedSpeedKnots: number | null
  polarSpeedKnots: number | null
  conditions: OnboardPlanConditions
  plan: Record<string, unknown> | null
}

export interface OnboardPlan {
  v: 1
  generatedAt: string
  packRevision: number
  ruleSetVersion: string
  observed: SailingAverages | null
  legs: OnboardPlanLeg[]
}

const MILLISECONDS_PER_HOUR = 3_600_000
const ASSUMED_MIDPOINT_SPEED_KNOTS = 6

export function buildOnboardPlan(options: { pack: RacePack; activeIndex: number; averages: SailingAverages | null; now: number; vessel?: VesselPerformance | null }): OnboardPlan {
  const points = options.pack.course.points
  const lastIndex = points.length - 1
  const firstIndex = Math.min(Math.max(options.activeIndex, 1), lastIndex)
  const forecasts = options.pack.legForecasts
  const legs: OnboardPlanLeg[] = []
  let cursor = options.now

  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const from = points[index - 1]!
    const to = points[index]!
    const distance = distanceNm(from.latitude, from.longitude, to.latitude, to.longitude)
    const bearing = bearingDegrees(from.latitude, from.longitude, to.latitude, to.longitude)
    const midpointAt = cursor + (distance / ASSUMED_MIDPOINT_SPEED_KNOTS) * MILLISECONDS_PER_HOUR / 2
    const conditions = index === firstIndex && options.averages
      ? observedConditions(options.averages)
      : forecastConditions(forecasts, midpointAt)
    const tws = conditions.twsKnots
    const twd = conditions.twdDeg
    const gust = conditions.gustKnots ?? tws
    const twa = tws !== null && twd !== null ? angularDifferenceDegrees(bearing, twd) : null
    const pointOfSail = twa !== null ? classifyPointOfSail(twa) : null
    const windSide = twd !== null ? (signedAngleDegrees(twd, bearing) > 0 ? 'starboard' : 'port') : null
    const [estimated, polarSpeed] = estimateLegSpeed(options.vessel ?? {}, pointOfSail, tws, gust, options.pack.polarSummary ?? null, twa, windSide)

    let plan: Record<string, unknown> | null = null
    if (pointOfSail !== null && tws !== null && twd !== null) {
      const apparent = apparentWind({ vesselCourseDeg: bearing, vesselSpeedKnots: estimated ?? 0, trueWindFromDeg: twd, trueWindSpeedKnots: tws })
      const apparentGust = apparentWind({ vesselCourseDeg: bearing, vesselSpeedKnots: estimated ?? 0, trueWindFromDeg: twd, trueWindSpeedKnots: gust ?? tws })
      const availableCrewCount = typeof options.pack.payload.availableCrewCount === 'number' ? options.pack.payload.availableCrewCount : null
      const [candidates] = recommendSails(options.pack.sails, {
        point_of_sail: pointOfSail,
        twa_deg: twa ?? 0,
        forecast_tws_knots: tws,
        forecast_gust_knots: gust ?? tws,
        awa_deg: apparent.awaDeg,
        aws_knots: apparent.awsKnots,
        apparent_gust_knots: apparentGust.awsKnots,
        available_crew_count: availableCrewCount
      })
      plan = buildRecommendedSailPlan({
        candidates,
        reefing: reefingRecommendation(options.pack.sails, { forecastTwsKnots: tws, forecastGustKnots: gust ?? tws }),
        pointOfSail,
        forecastTwsKnots: tws,
        forecastGustKnots: gust ?? tws,
        availableCrewCount
      })
    }

    legs.push({
      sequence: index,
      from: { name: from.name, latitude: from.latitude, longitude: from.longitude },
      to: { name: to.name, latitude: to.latitude, longitude: to.longitude },
      distanceNm: distance,
      bearingDeg: bearing,
      twaDeg: twa === null ? null : Math.round(twa * 10) / 10,
      pointOfSail,
      windSide,
      estimatedSpeedKnots: estimated,
      polarSpeedKnots: polarSpeed,
      conditions,
      plan
    })
    cursor += (distance / Math.max(estimated ?? 5, 0.5)) * MILLISECONDS_PER_HOUR
  }

  return {
    v: 1,
    generatedAt: new Date(options.now).toISOString(),
    packRevision: options.pack.revision,
    ruleSetVersion: options.pack.ruleSetVersion,
    observed: options.averages,
    legs
  }
}

function observedConditions(averages: SailingAverages): OnboardPlanConditions {
  return {
    source: 'observed',
    twsKnots: averages.twsKnots,
    twdDeg: averages.twdDeg,
    gustKnots: averages.twsKnots,
    waveHeightM: null,
    waveDirectionDeg: null,
    currentVelocityKn: null,
    currentDirectionDeg: null,
    sampleTime: null
  }
}

function forecastConditions(forecasts: RacePack['legForecasts'], targetAt: number): OnboardPlanConditions {
  if (!forecasts.length) {
    return { source: 'forecast', twsKnots: null, twdDeg: null, gustKnots: null, waveHeightM: null, waveDirectionDeg: null, currentVelocityKn: null, currentDirectionDeg: null, sampleTime: null }
  }
  let best = forecasts[0]!
  let bestDelta = Number.POSITIVE_INFINITY
  for (const forecast of forecasts) {
    const at = forecast.sample_time ? Date.parse(forecast.sample_time) : Number.NaN
    const delta = Number.isFinite(at) ? Math.abs(at - targetAt) : Number.POSITIVE_INFINITY
    if (delta < bestDelta) {
      best = forecast
      bestDelta = delta
    }
  }
  return {
    source: 'forecast',
    twsKnots: best.tws_knots,
    twdDeg: best.twd_deg,
    gustKnots: best.gust_knots ?? null,
    waveHeightM: best.wave_height_m ?? null,
    waveDirectionDeg: best.wave_direction_deg ?? null,
    currentVelocityKn: best.current_velocity_kn ?? null,
    currentDirectionDeg: best.current_direction_deg ?? null,
    sampleTime: best.sample_time ?? null
  }
}

function estimateLegSpeed(
  vessel: VesselPerformance,
  pointOfSail: string | null,
  tws: number | null,
  gust: number | null,
  polarSummary: RacePack['polarSummary'],
  twa: number | null,
  windSide: 'port' | 'starboard' | null
): [number | null, number | null] {
  if (pointOfSail === null || tws === null) return [null, null]
  const [estimated] = estimateBoatSpeedKnots({ vessel, pointOfSail, forecastTwsKnots: tws, forecastGustKnots: gust ?? tws })
  const [polar] = polarSpeedForLeg(polarSummary, { twaDeg: twa ?? 0, forecastTwsKnots: tws, windSide })
  return [polar ?? estimated, polar]
}