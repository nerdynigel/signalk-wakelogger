import { describe, expect, it } from 'vitest'
import { RollingAverages } from '../../src/race/averages'
import { parseRacePack, RacePackError, type RacePack } from '../../src/race/pack'
import { buildOnboardPlan } from '../../src/race/plan'
import type { SailInventoryItem } from '../../src/race/sailing/selection'

const NOW = Date.parse('2026-09-17T02:00:00Z')

function sail(overrides: Partial<SailInventoryItem> & { id: number }): SailInventoryItem {
  return {
    sail_name: 'Sail', sail_type: 'Custom sail', availability_status: 'Available', is_available: true, archived_at: null,
    max_aws_knots: null, min_awa_deg: null, max_awa_deg: null, min_twa_deg: null, max_twa_deg: null,
    min_tws_knots: null, max_tws_knots: null, crew_required: null,
    reef_1_tws_knots: null, reef_2_tws_knots: null, reef_3_tws_knots: null,
    ...overrides
  }
}

const SAILS: SailInventoryItem[] = [
  sail({ id: 1, sail_name: 'Doyle main', sail_type: 'Mainsail', min_twa_deg: 0, max_twa_deg: 180, min_tws_knots: 0, max_tws_knots: 25, crew_required: 1 }),
  sail({ id: 3, sail_name: 'No. 3 jib', sail_type: 'No. 3 jib', min_awa_deg: 0, max_awa_deg: 90, min_twa_deg: 0, max_twa_deg: 110, min_tws_knots: 8, max_tws_knots: 25, crew_required: 1 }),
  sail({ id: 5, sail_name: 'A2 kite', sail_type: 'Asymmetric A2', min_awa_deg: 60, max_awa_deg: 160, min_twa_deg: 70, max_twa_deg: 180, min_tws_knots: 6, max_tws_knots: 22, crew_required: 3 })
]

function pack(overrides: Partial<RacePack> = {}): RacePack {
  return {
    v: 1,
    kind: 'race_pack',
    revision: 4,
    generatedAt: '2026-09-17T01:00:00Z',
    ruleSetVersion: 'race_plan_preview_v1',
    course: {
      courseId: 'race-42',
      name: 'Saturday bay race',
      points: [
        { name: 'Race start', latitude: -27.4, longitude: 153.17, kind: 'start', rounding: 'either' },
        { name: 'Eastern mark', latitude: -27.39, longitude: 153.17, kind: 'mark', rounding: 'starboard' },
        { name: 'Race finish', latitude: -27.39, longitude: 153.19, kind: 'finish', rounding: 'either' }
      ]
    },
    sails: SAILS,
    payload: { startTime: '2026-09-17T02:00:00Z', availableCrewCount: 3 },
    legForecasts: [
      { sequence: 1, sample_time: '2026-09-17T02:00:00Z', twd_deg: 45, tws_knots: 14, gust_knots: 18, wave_height_m: 0.6, wave_direction_deg: 60, current_velocity_kn: 0.4, current_direction_deg: 200 },
      { sequence: 2, sample_time: '2026-09-17T03:00:00Z', twd_deg: 90, tws_knots: 12, gust_knots: 15, wave_height_m: 0.4, wave_direction_deg: 90, current_velocity_kn: null, current_direction_deg: null }
    ],
    polarSummary: { eligible: false },
    ...overrides
  }
}

describe('race pack parsing', () => {
  it('accepts a valid pack and rejects malformed documents', () => {
    const parsed = parseRacePack(Buffer.from(JSON.stringify(pack())))
    expect(parsed.revision).toBe(4)
    expect(parsed.course.points).toHaveLength(3)

    const invalid = (mutate: (value: RacePack) => void, code: string) => {
      const value = pack()
      mutate(value)
      expect(() => parseRacePack(Buffer.from(JSON.stringify(value)))).toThrow(RacePackError)
      try { parseRacePack(Buffer.from(JSON.stringify(value))) } catch (error) { expect((error as RacePackError).code).toBe(code) }
    }
    invalid((value) => { value.kind = 'something_else' as never }, 'pack_invalid')
    invalid((value) => { value.revision = 0 }, 'pack_invalid')
    invalid((value) => { value.course.points = value.course.points.slice(0, 1) }, 'pack_invalid_course')
    invalid((value) => { value.course.points[0]!.latitude = 120 }, 'pack_invalid_course')
    invalid((value) => { value.legForecasts[0]!.tws_knots = Number.NaN }, 'pack_invalid_forecasts')
    invalid((value) => { value.sails = [{ sail_name: 'no id' } as never] }, 'pack_invalid_sails')
    expect(() => parseRacePack(Buffer.from('not json'))).toThrow(RacePackError)
    expect(() => parseRacePack(Buffer.alloc(300 * 1024, 32))).toThrow(RacePackError)
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
    expect(plan.ruleSetVersion).toBe('race_plan_preview_v1')
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
    expect(second.plan).not.toBeNull()
  })

  it('returns legs without plans when no conditions are available', () => {
    const plan = buildOnboardPlan({ pack: pack({ legForecasts: [] }), activeIndex: 2, averages: null, now: NOW })
    expect(plan.legs).toHaveLength(1)
    expect(plan.legs[0]!.conditions.twsKnots).toBeNull()
    expect(plan.legs[0]!.plan).toBeNull()
  })
})