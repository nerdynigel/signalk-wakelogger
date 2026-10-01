import { describe, expect, it } from 'vitest'
import { parseRacePack, type RacePack } from '../../src/race/pack'
import { buildOnboardPlan } from '../../src/race/plan'
import { makeFixturePack, type FixturePack } from '../helpers/race-pack'

const NOW = Date.parse('2026-09-17T02:00:00Z')

function toPack(fixture: FixturePack): RacePack {
  return parseRacePack(Buffer.from(JSON.stringify(fixture), 'utf8'))
}

// Wake Logger represents a reversed race by storing the route points in
// reversed order. That is a normal ordered course to the onboard planner: it
// must follow the stored order exactly and must not reverse it again. The
// separate Signal K native `reverse=true` case (an active route flagged
// reversed) is rejected fail-closed as `reverse_course_unsupported`; see the
// dedicated case in `onboard-service.test.ts`.
describe('reversed Wake Logger route-point ordering', () => {
  it('calculates through the stored (reversed) point order as a normal forward course', () => {
    const pack = toPack(makeFixturePack({
      course: {
        courseId: 'race-reversed', racePlanId: 77, name: 'Reversed bay race',
        points: [
          { id: 'p3', name: 'Original finish (now first)', latitude: -27.39, longitude: 153.19, kind: 'start' },
          { id: 'p2', name: 'Middle mark', latitude: -27.39, longitude: 153.17, kind: 'mark' },
          { id: 'p1', name: 'Original start (now last)', latitude: -27.4, longitude: 153.17, kind: 'finish' }
        ]
      },
      racePlanId: 77
    }))
    const plan = buildOnboardPlan({ pack, activeIndex: 1, averages: null, now: NOW })
    // The planner follows the stored order: from the first stored point it
    // heads to the second, then the third — never back through a re-reversal.
    expect(plan.legs.map((leg) => leg.to.name)).toEqual(['Middle mark', 'Original start (now last)'])
    expect(plan.legs.map((leg) => leg.sequence)).toEqual([1, 2])
    expect(plan.completedLegCount).toBe(0)
    // The recommendation is produced against the stored geometry, so every leg
    // has a plan even though the ordering is reversed from the original race.
    expect(plan.legs.every((leg) => leg.plan !== null)).toBe(true)
  })

  it('is deterministic for a reversed-ordering pack', () => {
    const pack = toPack(makeFixturePack({
      course: {
        courseId: 'race-reversed', racePlanId: 77, name: 'Reversed bay race',
        points: [
          { id: 'p3', name: 'Seaward mark', latitude: -27.39, longitude: 153.19, kind: 'start' },
          { id: 'p2', name: 'Midway mark', latitude: -27.39, longitude: 153.17, kind: 'mark' },
          { id: 'p1', name: 'Harbour mark', latitude: -27.4, longitude: 153.17, kind: 'finish' }
        ]
      },
      racePlanId: 77
    }))
    const first = buildOnboardPlan({ pack, activeIndex: 1, averages: null, now: NOW })
    const second = buildOnboardPlan({ pack, activeIndex: 1, averages: null, now: NOW })
    expect(first).toEqual(second)
    expect(first.legs[0]!.to.name).toBe('Midway mark')
  })
})
