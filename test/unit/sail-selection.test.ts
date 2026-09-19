import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildRecommendedSailPlan,
  candidateForSail,
  confidenceForScore,
  mainsailConfiguration,
  rangeScore,
  recommendSails,
  reefingRecommendation,
  sailCategory,
  sailTypeScore,
  type CandidateParams,
  type SailInventoryItem
} from '../../src/race/sailing/selection'

interface FixtureCase { input: Record<string, any>; output: any }
const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'sail-physics.json'), 'utf8')) as {
  cases: Record<string, FixtureCase[]>
  scenarios: Record<string, CandidateParams>
}

const cases = (name: string): FixtureCase[] => fixture.cases[name]!
const sailsFrom = (rows: unknown): SailInventoryItem[] => (rows as SailInventoryItem[]) ?? []

// Python's round() keeps integers when its input is an int, so its messages can
// read "10" where the JSON round-trip through JavaScript yields "10.0".
// Normalise that cosmetic difference before comparing text.
const normalizeText = (value: string): string => value.replace(/(\d)\.0(?=\D|$)/g, '$1')

function expectClose(actual: unknown, expected: unknown): void {
  if (expected === null || expected === undefined) {
    expect(actual ?? null).toBeNull()
    return
  }
  if (typeof expected === 'number') {
    expect(typeof actual).toBe('number')
    expect(actual as number).toBeCloseTo(expected, 3)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true)
    expect((actual as unknown[]).length).toBe(expected.length)
    expected.forEach((value, index) => expectClose((actual as unknown[])[index], value))
    return
  }
  if (typeof expected === 'object') {
    const record = actual as Record<string, unknown>
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) expectClose(record?.[key], value)
    return
  }
  if (typeof expected === 'string') {
    expect(normalizeText(String(actual))).toEqual(normalizeText(expected))
    return
  }
  expect(actual).toEqual(expected)
}

describe('sail selection parity with the Wake Logger calculation', () => {
  it('matches sail categories and configuration labels', () => {
    for (const row of cases('sailCategory')) expect(sailCategory(row.input.sailType)).toBe(row.output)
    for (const row of cases('mainsailConfiguration')) {
      expect(mainsailConfiguration({ status: row.input.status }, { trysailAvailable: row.input.trysailAvailable })).toBe(row.output)
    }
    for (const row of cases('confidenceForScore')) expect(confidenceForScore(row.input.score, row.input.warnings)).toBe(row.output)
  })

  it('matches range and sail-type scoring including reasons and warnings', () => {
    for (const row of cases('rangeScore')) {
      const reasons: string[] = []
      const warnings: string[] = []
      const score = rangeScore({ value: row.input.value, minimum: row.input.minimum, maximum: row.input.maximum, label: 'TWA', reasons, warnings, primary: row.input.primary })
      expect(score).toBeCloseTo(row.output.score, 3)
      expect(reasons.map(normalizeText)).toEqual(row.output.reasons.map(normalizeText))
      expect(warnings.map(normalizeText)).toEqual(row.output.warnings.map(normalizeText))
    }
    for (const row of cases('sailTypeScore')) {
      const reasons: string[] = []
      const warnings: string[] = []
      const score = sailTypeScore(row.input.sailType, row.input.pointOfSail, row.input.forecastTwsKnots, reasons, warnings)
      expect(score).toBeCloseTo(row.output.score, 3)
      expect(reasons.map(normalizeText)).toEqual(row.output.reasons.map(normalizeText))
      expect(warnings.map(normalizeText)).toEqual(row.output.warnings.map(normalizeText))
    }
  })

  it('matches reefing recommendations', () => {
    for (const row of cases('reefingRecommendation')) {
      const result = reefingRecommendation(sailsFrom(row.input.sails), { forecastTwsKnots: row.input.forecastTwsKnots, forecastGustKnots: row.input.forecastGustKnots })
      expectClose(result, row.output)
    }
  })

  it('matches per-sail candidate scoring', () => {
    for (const row of cases('candidateForSail')) {
      const result = candidateForSail(row.input.sail as SailInventoryItem, fixture.scenarios[row.input.scenario]!)
      expectClose(result, row.output)
    }
  })

  it('matches ranked recommendations', () => {
    for (const row of cases('recommendSails')) {
      const [candidates, recommendation] = recommendSails(sailsFrom(row.input.sails), fixture.scenarios[row.input.scenario]!)
      expectClose(candidates, row.output.candidates)
      expectClose(recommendation, row.output.recommendation)
    }
  })

  it('matches complete sail plans for every scenario', () => {
    for (const row of cases('buildRecommendedSailPlan')) {
      const sails = sailsFrom(row.input.sails)
      const params = { ...fixture.scenarios[row.input.scenario]!, available_crew_count: row.input.crew }
      const [candidates] = recommendSails(sails, params)
      const reefing = reefingRecommendation(sails, { forecastTwsKnots: params.forecast_tws_knots, forecastGustKnots: params.forecast_gust_knots })
      const plan = buildRecommendedSailPlan({
        candidates,
        reefing,
        pointOfSail: params.point_of_sail,
        forecastTwsKnots: params.forecast_tws_knots,
        forecastGustKnots: params.forecast_gust_knots,
        availableCrewCount: params.available_crew_count
      })
      expectClose(plan, row.output)
    }
  })
})