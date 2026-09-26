import { describe, expect, it } from 'vitest'
import { parseRacePack, RacePackError, racePackAppliesToCourse, racePackIdentity, type RacePack } from '../../src/race/pack'
import { FIXTURE_COURSE_DIGEST, makeFixturePack } from '../helpers/race-pack'

function pack(overrides: Parameters<typeof makeFixturePack>[0] = {}): RacePack {
  return parseRacePack(Buffer.from(JSON.stringify(makeFixturePack(overrides))))
}

const COURSE = { courseId: 'race-42', racePlanId: 42, courseDefinitionDigest: FIXTURE_COURSE_DIGEST }

describe('course-definition digest enforcement', () => {
  it('exposes the digest through parsing and identity', () => {
    const parsed = pack()
    expect(parsed.courseDefinitionDigest).toBe(FIXTURE_COURSE_DIGEST)
    expect(racePackIdentity(parsed).courseDefinitionDigest).toBe(FIXTURE_COURSE_DIGEST)
  })

  it('applies when the course definition digest matches', () => {
    expect(racePackAppliesToCourse(pack(), COURSE)).toBe(true)
  })

  it('stays applicable when only active waypoint progress changes', () => {
    // Progress is not part of the digest; advancing the active index must not
    // invalidate an otherwise identical course.
    const first = { ...COURSE, activeIndex: 1 }
    const advanced = { ...COURSE, activeIndex: 2 }
    expect(racePackAppliesToCourse(pack(), first)).toBe(true)
    expect(racePackAppliesToCourse(pack(), advanced)).toBe(true)
  })

  it('is not applicable when a mark coordinate changes the digest', () => {
    const moved = { ...COURSE, courseDefinitionDigest: 'b'.repeat(64) }
    expect(racePackAppliesToCourse(pack(), moved)).toBe(false)
  })

  it('is not applicable when structured course metadata changes the digest', () => {
    // Rounding/kind/gate/line metadata are part of the definition, so a
    // server-side change produces a different digest and the pack is rejected.
    const roundingChanged = { ...COURSE, courseDefinitionDigest: 'c'.repeat(64) }
    expect(racePackAppliesToCourse(pack(), roundingChanged)).toBe(false)
  })

  it('is not applicable when either side has no digest', () => {
    expect(racePackAppliesToCourse(pack({ courseDefinitionDigest: null }), COURSE)).toBe(false)
    expect(racePackAppliesToCourse(pack(), { courseId: 'race-42', racePlanId: 42 })).toBe(false)
  })

  it('is not applicable when the course id or plan does not match', () => {
    expect(racePackAppliesToCourse(pack(), { ...COURSE, courseId: 'race-other' })).toBe(false)
    expect(racePackAppliesToCourse(pack(), { ...COURSE, racePlanId: 999 })).toBe(false)
  })

  it('rejects a malformed digest at parse time', () => {
    expect(() => pack({ courseDefinitionDigest: 'not-a-digest' })).toThrow(RacePackError)
    try { pack({ courseDefinitionDigest: 'not-a-digest' }) } catch (error) { expect((error as RacePackError).code).toBe('pack_invalid_course_digest') }
  })
})
