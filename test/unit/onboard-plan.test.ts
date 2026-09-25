import { describe, expect, it } from 'vitest'
import { RollingAverages } from '../../src/race/averages'
import { parseRacePack, RacePackError, type RacePack } from '../../src/race/pack'
import { buildOnboardPlan } from '../../src/race/plan'
import { makeFixturePack, type FixturePack } from '../helpers/race-pack'

const NOW = Date.parse('2026-09-17T02:00:00Z')

function toPack(fixture: FixturePack): RacePack {
  return parseRacePack(Buffer.from(JSON.stringify(fixture), 'utf8'))
}

function pack(overrides: Partial<FixturePack> = {}): RacePack {
  return toPack(makeFixturePack(overrides))
}

describe('race pack parsing', () => {
  it('accepts a valid pack and rejects malformed documents', () => {
    const parsed = parseRacePack(Buffer.from(JSON.stringify(makeFixturePack())))
    expect(parsed.revision).toBe(4)
    expect(parsed.course.points).toHaveLength(3)
    expect(parsed.forecast.legs).toHaveLength(2)
    expect(parsed.forecast.legs[0]!.samples).toHaveLength(3)

    const invalid = (mutate: (value: FixturePack) => void, code: string) => {
      const value = makeFixturePack()
      mutate(value)
      expect(() => parseRacePack(Buffer.from(JSON.stringify(value)))).toThrow(RacePackError)
      try { parseRacePack(Buffer.from(JSON.stringify(value))) } catch (error) { expect((error as RacePackError).code).toBe(code) }
    }
    invalid((value) => { value.kind = 'something_else' as never }, 'pack_invalid')
    invalid((value) => { value.revision = 0 }, 'pack_invalid')
    invalid((value) => { value.ruleSetVersion = 'race_plan_preview_v1' }, 'unsupported_rule_set')
    invalid((value) => { value.course.points = value.course.points.slice(0, 1) }, 'pack_invalid_course')
    invalid((value) => { value.course.points[0]!.latitude = 120 }, 'pack_invalid_course')
    invalid((value) => { value.forecast.legs[0]!.samples[1]!.tws_knots = Number.NaN }, 'pack_invalid_forecast')
    invalid((value) => { value.forecast.legs = value.forecast.legs.slice(0, 1) }, 'forecast_leg_coverage')
    invalid((value) => { for (const leg of value.forecast.legs) leg.samples = leg.samples.slice(0, 1) }, 'forecast_timeline_insufficient')
    invalid((value) => { value.sails = [{ sail_name: 'no id' } as never] }, 'pack_invalid_sails')
    invalid((value) => { value.raceHeadsail = { sail_id: 'three' } as never }, 'pack_invalid_race_headsail')
    expect(() => parseRacePack(Buffer.from('not json'))).toThrow(RacePackError)
    expect(() => parseRacePack(Buffer.alloc(2 * 1024 * 1024, 32))).toThrow(RacePackError)
  })

  it('rejects a pack when any later leg lacks sufficient temporal coverage', () => {
    const shortLeg = makeFixturePack()
    shortLeg.forecast.legs[1]!.samples = shortLeg.forecast.legs[1]!.samples.slice(0, 1)
    expect(() => parseRacePack(Buffer.from(JSON.stringify(shortLeg)))).toThrow(/forecast_timeline_insufficient/)

    const sparse = makeFixturePack()
    sparse.forecast.legs[1]!.samples = [
      sparse.forecast.legs[1]!.samples[0]!,
      { ...sparse.forecast.legs[1]!.samples[0]!, time: '2026-09-18T06:00:00Z' }
    ]
    expect(() => parseRacePack(Buffer.from(JSON.stringify(sparse)))).toThrow(/forecast_gap_too_large/)

    const uncovered = makeFixturePack()
    uncovered.forecast.coverage = { from: '2026-09-17T00:00:00Z', until: '2026-09-18T00:00:00Z' }
    expect(() => parseRacePack(Buffer.from(JSON.stringify(uncovered)))).toThrow(/forecast_coverage_gap/)
  })
})

describe('rolling sailing averages', () => {
  it('averages speed and wind circularly within the window', () => {
    const averages = new RollingAverages(300_000)
    averages.add({ at: NOW - 240_000, twsKnots: 10, twdDeg: 350, headingDeg: 20, sogKnots: 5 })
    averages.add({ at: NOW - 120_000, twsKnots: 14, twdDeg: 10, headingDeg: 40, sogKnots: 7 })
    const value = averages.value(NOW)!
    expect(value.twsKnots).toBeCloseTo(12, 3)
    expect(value.sogKnots).toBeCloseTo(6, 3)
    expect(value.twdDeg === null ? null : Math.round(value.twdDeg)).toBe(0)
    expect(value.headingDeg === null ? null : Math.round(value.headingDeg)).toBe(30)
    expect(value.sampleCount).toBe(2)
    expect(averages.value(NOW + 400_000)).toBeNull()
  })
})

describe('onboard sail plan', () => {
  it('builds the remaining legs from observed and forecast conditions', () => {
    const averages = new RollingAverages()
    averages.add({ at: NOW, twsKnots: 12, twdDeg: 45, headingDeg: 10, sogKnots: 6 })
    const plan = buildOnboardPlan({ pack: pack(), activeIndex: 1, averages: averages.value(NOW), now: NOW })
    expect(plan.packRevision).toBe(4)
    expect(plan.ruleSetVersion).toBe('race_plan_dynamic_v1')
    expect(plan.legs).toHaveLength(2)

    const first = plan.legs[0]!
    expect(first.to.name).toBe('Eastern mark')
    expect(first.conditions.source).toBe('observed')
    expect(first.pointOfSail).not.toBeNull()
    expect(first.windSide === 'port' || first.windSide === 'starboard').toBe(true)
    expect(first.plan?.summary).toContain('main')

    const second = plan.legs[1]!
    expect(second.to.name).toBe('Race finish')
    expect(second.conditions.source).toBe('forecast')
    expect(second.conditions.twsKnots).not.toBeNull()
    expect(second.conditions.sampleTime).toBe('2026-09-17T02:00:00Z')
    expect(second.plan).not.toBeNull()
  })

  it('returns legs without plans when the current observation has no wind', () => {
    const averages = new RollingAverages()
    averages.add({ at: NOW, twsKnots: null, twdDeg: null, headingDeg: 10, sogKnots: 6 })
    const plan = buildOnboardPlan({ pack: pack(), activeIndex: 1, averages: averages.value(NOW), now: NOW })
    expect(plan.legs).toHaveLength(2)
    expect(plan.legs[0]!.conditions.twsKnots).toBeNull()
    expect(plan.legs[0]!.plan).toBeNull()
    expect(plan.legs[1]!.conditions.twsKnots).not.toBeNull()
  })

  it('does not recalculate completed legs', () => {
    const plan = buildOnboardPlan({ pack: pack(), activeIndex: 2, averages: null, now: NOW })
    expect(plan.completedLegCount).toBe(1)
    expect(plan.activeLegSequence).toBe(2)
    expect(plan.legs.map((leg) => leg.sequence)).toEqual([2])
    expect(plan.legs.map((leg) => leg.to.name)).toEqual(['Race finish'])
  })

  it('uses each leg own forecast series at its recalculated ETA and never another leg series', () => {
    // Leg 2 has a materially different forecast at 13:00 (light) and 15:00
    // (heavy). Leg 1 is long, so a slow actual progress pushes Leg 2's
    // midpoint near 15:00 while fast progress keeps it near 13:00.
    const build = () => toPack(makeFixturePack({
      course: {
        courseId: 'race-42', racePlanId: 42, name: 'ETA shift', points: [
          { id: 's', name: 'Start', latitude: -27.4, longitude: 153.17, kind: 'start' },
          { id: 'm', name: 'Far mark', latitude: -27.4, longitude: 153.3014, kind: 'mark' },
          { id: 'f', name: 'Finish', latitude: -27.4, longitude: 153.339, kind: 'finish' }
        ]
      },
      forecast: {
        snapshot: { provider: 'example-model' },
        coverage: { from: '2026-09-17T13:00:00Z', until: '2026-09-17T15:00:00Z' },
        legs: [
          { sequence: 1, latitude: -27.4, longitude: 153.24, samples: [
            { time: '2026-09-17T13:00:00Z', twd_deg: 200, tws_knots: 8 },
            { time: '2026-09-17T15:00:00Z', twd_deg: 20, tws_knots: 24 }
          ] },
          { sequence: 2, latitude: -27.4, longitude: 153.32, samples: [
            { time: '2026-09-17T13:00:00Z', twd_deg: 200, tws_knots: 8, gust_knots: 12 },
            { time: '2026-09-17T15:00:00Z', twd_deg: 20, tws_knots: 24, gust_knots: 30 }
          ] }
        ]
      }
    }))
    const now = Date.parse('2026-09-17T11:00:00Z')
    const average = (tws: number) => {
      const rolling = new RollingAverages()
      rolling.add({ at: now, twsKnots: tws, twdDeg: 180, headingDeg: 90, sogKnots: 5 })
      return rolling.value(now)
    }
    const fast = buildOnboardPlan({ pack: build(), activeIndex: 1, averages: average(20), now })
    const slow = buildOnboardPlan({ pack: build(), activeIndex: 1, averages: average(4), now })
    expect(fast.legs[1]!.conditions.sampleTime).toBe('2026-09-17T13:00:00Z')
    expect(fast.legs[1]!.conditions.twsKnots).toBe(8)
    expect(slow.legs[1]!.conditions.sampleTime).toBe('2026-09-17T15:00:00Z')
    expect(slow.legs[1]!.conditions.twsKnots).toBe(24)
    // The recommendation itself moves with the later forecast.
    expect(slow.legs[1]!.pointOfSail).not.toBe(fast.legs[1]!.pointOfSail)
    expect(JSON.stringify(slow.legs[1]!.plan)).not.toBe(JSON.stringify(fast.legs[1]!.plan))
  })

  it('binds the cloud-selected race headsail so the vessel cannot substitute another race jib', () => {
    const headsail = pack({ raceHeadsail: { sail_id: 5, sail_name: 'A2 kite' }, payload: { availableCrewCount: 3, jibChangesAllowed: false } })
    const plan = buildOnboardPlan({ pack: headsail, activeIndex: 1, averages: null, now: NOW })
    expect(plan.legs[0]!.plan?.race_headsail).toMatchObject({ sail_id: 5, sail_name: 'A2 kite' })
    expect(plan.legs[0]!.plan?.jib_changes_allowed).toBe(false)
  })

  it('marks a future leg stale once the recalculated ETA leaves the forecast window', () => {
    // The fixture's leg 2 series covers 02:00-04:00. An 11:00 ETA is more than
    // 6 h past the last sample, so it must not reuse the 04:00 value.
    const outside = buildOnboardPlan({ pack: pack(), activeIndex: 2, averages: null, now: Date.parse('2026-09-17T11:00:00Z') })
    expect(outside.forecastCoverage).toBe('partial')
    expect(outside.warnings.join(' ')).toMatch(/Leg 2 forecast does not cover/)
    expect(outside.legs[0]!.conditions.forecastCoverage).toBe('out_of_range')
    expect(outside.legs[0]!.conditions.twsKnots).toBeNull()
    expect(outside.legs[0]!.plan).toBeNull()

    // Within the extrapolation bound the nearest sample is still used.
    const inside = buildOnboardPlan({ pack: pack(), activeIndex: 2, averages: null, now: Date.parse('2026-09-17T09:00:00Z') })
    expect(inside.forecastCoverage).toBe('complete')
    expect(inside.legs[0]!.conditions.forecastCoverage).toBe('within')
    expect(inside.legs[0]!.conditions.twsKnots).not.toBeNull()
  })

  it('is deterministic for identical inputs and reports the estimated finish', () => {
    const options = { pack: pack(), activeIndex: 1, averages: null, now: NOW }
    const first = buildOnboardPlan(options)
    const second = buildOnboardPlan(options)
    expect(first).toEqual(second)
    expect(first.estimatedFinishAt).not.toBeNull()
    expect(first.remainingDurationSeconds).toBeGreaterThan(0)
    expect(first.packId).toBe('pack-42-1')
  })
})
