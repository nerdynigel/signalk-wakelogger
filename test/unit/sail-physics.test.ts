import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  angularDifferenceDegrees,
  apparentWind,
  bearingDegrees,
  bestUpwindTargetFromPolarSummary,
  classifyPointOfSail,
  currentComponents,
  distanceNm,
  estimateBoatSpeedKnots,
  hullSpeedForVessel,
  normalizeDegrees,
  polarSpeedForLeg,
  sailingCourseForTargetTwa,
  sailingSideForCourse,
  signedAngleDegrees,
  waveAngleToLeg,
  type PolarSummary,
  type VesselPerformance
} from '../../src/race/sailing/physics'

interface FixtureCase { input: Record<string, any>; output: any }
const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'sail-physics.json'), 'utf8')) as { cases: Record<string, FixtureCase[]> }

const cases = (name: string): FixtureCase[] => fixture.cases[name]!

describe('sail physics parity with the Wake Logger calculation', () => {
  it('normalises, compares and signs angles exactly', () => {
    for (const row of cases('normalizeDegrees')) expect(normalizeDegrees(row.input.value)).toBeCloseTo(row.output, 6)
    for (const row of cases('angularDifferenceDegrees')) expect(angularDifferenceDegrees(row.input.left, row.input.right)).toBeCloseTo(row.output, 6)
    for (const row of cases('signedAngleDegrees')) expect(signedAngleDegrees(row.input.left, row.input.right)).toBeCloseTo(row.output, 6)
  })

  it('matches bearing and distance', () => {
    for (const row of cases('bearingDegrees')) {
      expect(bearingDegrees(row.input.fromLat, row.input.fromLon, row.input.toLat, row.input.toLon)).toBeCloseTo(row.output, 3)
    }
    for (const row of cases('distanceNm')) {
      expect(distanceNm(row.input.fromLat, row.input.fromLon, row.input.toLat, row.input.toLon)).toBeCloseTo(row.output, 3)
    }
  })

  it('classifies points of sail', () => {
    for (const row of cases('classifyPointOfSail')) expect(classifyPointOfSail(row.input.twaDeg)).toBe(row.output)
  })

  it('matches sailing course and side', () => {
    for (const row of cases('sailingCourseForTargetTwa')) {
      expect(sailingCourseForTargetTwa({ legBearingDeg: row.input.legBearingDeg, trueWindFromDeg: row.input.trueWindFromDeg, targetTwaDeg: row.input.targetTwaDeg })).toBeCloseTo(row.output, 3)
    }
    for (const row of cases('sailingSideForCourse')) {
      expect(sailingSideForCourse({ sailingCourseDeg: row.input.sailingCourseDeg, trueWindFromDeg: row.input.trueWindFromDeg, pointOfSail: row.input.pointOfSail })).toEqual(row.output)
    }
  })

  it('matches apparent wind', () => {
    for (const row of cases('apparentWind')) {
      const result = apparentWind({ vesselCourseDeg: row.input.vesselCourseDeg, vesselSpeedKnots: row.input.vesselSpeedKnots, trueWindFromDeg: row.input.trueWindFromDeg, trueWindSpeedKnots: row.input.trueWindSpeedKnots })
      expect(result.apparentWindFromDeg).toBeCloseTo(row.output.apparent_wind_from_deg, 2)
      expect(result.awaDeg).toBeCloseTo(row.output.awa_deg, 2)
      expect(result.awsKnots).toBeCloseTo(row.output.aws_knots, 2)
    }
  })

  it('matches hull speed and estimated boat speed', () => {
    for (const row of cases('hullSpeedForVessel')) {
      const [speed, source] = hullSpeedForVessel(row.input.vessel as VesselPerformance)
      expect(speed).toBeCloseTo(row.output.speed, 4)
      expect(source).toBe(row.output.source)
    }
    for (const row of cases('estimateBoatSpeedKnots')) {
      const [speed, warnings] = estimateBoatSpeedKnots({ vessel: row.input.vessel as VesselPerformance, pointOfSail: row.input.pointOfSail, forecastTwsKnots: row.input.forecastTwsKnots, forecastGustKnots: row.input.forecastGustKnots })
      expect(speed).toBeCloseTo(row.output.speed, 3)
      expect(warnings).toEqual(row.output.warnings)
    }
  })

  it('matches current and wave angles', () => {
    for (const row of cases('currentComponents')) {
      const result = currentComponents({ currentVelocityKn: row.input.currentVelocityKn, currentDirectionDeg: row.input.currentDirectionDeg, legBearingDeg: row.input.legBearingDeg })
      expect(result.currentAngleToLegDeg === null ? null : result.currentAngleToLegDeg).toBeCloseTo(row.output.current_angle_to_leg_deg, 3)
      if (row.output.current_along_leg_kn === null) expect(result.currentAlongLegKn).toBeNull()
      else expect(result.currentAlongLegKn).toBeCloseTo(row.output.current_along_leg_kn, 3)
      if (row.output.current_cross_leg_kn === null) expect(result.currentCrossLegKn).toBeNull()
      else expect(result.currentCrossLegKn).toBeCloseTo(row.output.current_cross_leg_kn, 3)
      expect(result.estimatedSogDeltaKn).toBeCloseTo(row.output.estimated_sog_delta_kn, 6)
    }
    for (const row of cases('waveAngleToLeg')) {
      const result = waveAngleToLeg({ waveDirectionDeg: row.input.waveDirectionDeg, legBearingDeg: row.input.legBearingDeg })
      if (row.output === null) expect(result).toBeNull()
      else expect(result).toBeCloseTo(row.output, 3)
    }
  })

  it('matches polar target and speed selection', () => {
    for (const row of cases('bestUpwindTargetFromPolarSummary')) {
      const [twa, source] = bestUpwindTargetFromPolarSummary(row.input.polarSummary as PolarSummary | null, row.input.forecastTwsKnots)
      expect(twa).toBeCloseTo(row.output.twa, 3)
      expect(source).toBe(row.output.source)
    }
    for (const row of cases('polarSpeedForLeg')) {
      const [speed, match] = polarSpeedForLeg(row.input.polarSummary as PolarSummary | null, { twaDeg: row.input.twaDeg, forecastTwsKnots: row.input.forecastTwsKnots, windSide: row.input.windSide })
      if (row.output.speed === null) {
        expect(speed).toBeNull()
        expect(match).toBeNull()
      } else {
        expect(speed).toBeCloseTo(row.output.speed, 3)
        expect(match).toMatchObject({
          source: row.output.match.source,
          bucketLabel: row.output.match.bucket_label,
          bucketSide: row.output.match.bucket_side,
          sampleCount: row.output.match.sample_count
        })
        expect(match!.bucketTwaDeg).toBeCloseTo(row.output.match.bucket_twa_deg, 3)
        expect(match!.bucketTwsKn).toBeCloseTo(row.output.match.bucket_tws_kn, 3)
      }
    }
  })
})