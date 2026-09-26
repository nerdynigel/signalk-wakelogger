import { describe, expect, it } from 'vitest'
import { parseRacePack } from '../../src/race/pack'
import { buildOnboardPlan } from '../../src/race/plan'
import { vesselPerformanceFromPack } from '../../src/race/onboard-service'
import { makeFixturePack } from '../helpers/race-pack'

function parse(pack: object) {
  return parseRacePack(Buffer.from(JSON.stringify(pack)))
}

describe('vesselPerformance consumption', () => {
  it('parses and maps the pack vessel performance into planner fields', () => {
    const pack = parse(makeFixturePack({ vesselPerformance: { hullSpeedKnots: 7.5, lengthWaterlineM: 10.4, lengthM: 12.0 } }))
    expect(pack.vesselPerformance).toEqual({ hullSpeedKnots: 7.5, lengthWaterlineM: 10.4, lengthM: 12.0 })
    expect(vesselPerformanceFromPack(pack)).toEqual({ hull_speed_knots: 7.5, length_waterline_m: 10.4, length_m: 12.0 })
  })

  it('rejects malformed vessel performance', () => {
    expect(() => parse(makeFixturePack({ vesselPerformance: { hullSpeedKnots: -1 } }))).toThrow(/vessel_performance/)
  })

  it('uses vessel performance hull speed instead of the generic fallback', () => {
    const pack = parse(makeFixturePack({ vesselPerformance: { hullSpeedKnots: 8 } }))
    const plan = buildOnboardPlan({
      pack,
      activeIndex: 1,
      averages: null,
      now: Date.parse('2026-09-17T02:00:00Z'),
      vessel: vesselPerformanceFromPack(pack)
    })
    expect(plan.legs[0]!.estimatedSpeedKnots).toBeGreaterThan(0)
    expect(plan.warnings.join(' ')).not.toContain('default hull speed')
  })

  it('warns when no polar or vessel performance is available', () => {
    const pack = parse(makeFixturePack({ vesselPerformance: null, polarSummary: { eligible: false } }))
    const plan = buildOnboardPlan({ pack, activeIndex: 1, averages: null, now: Date.parse('2026-09-17T02:00:00Z') })
    expect(plan.warnings.join(' ')).toContain('default hull speed')
  })
})
