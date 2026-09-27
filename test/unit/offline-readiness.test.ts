import { describe, expect, it } from 'vitest'
import { offlineReadiness, type ReadinessPackState } from '../../src/race/readiness'

const NOW = Date.parse('2026-09-17T02:05:00Z')
const DIGEST = 'a'.repeat(64)

const course = { action: 'activate', revision: 7, courseId: 'race-42', racePlanId: 42, courseDefinitionDigest: DIGEST }
const acknowledgement = { status: 'applied', revision: 7 }
const native = { available: true, activeMatchesDesired: true, conflict: false }

function pack(overrides: Partial<ReadinessPackState> = {}): ReadinessPackState {
  return {
    available: true,
    applicable: true,
    revision: 4,
    ruleSetVersion: 'race_plan_dynamic_v1',
    courseId: 'race-42',
    racePlanId: 42,
    courseDefinitionDigest: DIGEST,
    validUntil: '2035-01-01T00:00:00Z',
    currentAt: 'valid',
    ...overrides
  }
}

describe('coupled offline readiness', () => {
  it('is ready only when course, native route, pack, forecast and rule set all agree', () => {
    const result = offlineReadiness({ course, acknowledgement, native, pack: pack(), now: NOW })
    expect(result.ready).toBe(true)
    expect(result.label).toBe('Offline race ready')
    expect(result.missing).toEqual([])
  })

  it('is not ready without a selected or applied course', () => {
    const none = offlineReadiness({ course: null, acknowledgement: null, native, pack: pack(), now: NOW })
    expect(none.ready).toBe(false)
    expect(none.missing).toContain('no Wake Logger course is selected')

    const rejected = offlineReadiness({ course, acknowledgement: { status: 'rejected', revision: 7 }, native, pack: pack(), now: NOW })
    expect(rejected.ready).toBe(false)
    expect(rejected.missing).toContain('the selected course has not been applied')
  })

  it('is not ready when the expected native route is inactive or another app owns it', () => {
    const inactive = offlineReadiness({ course, acknowledgement, native: { available: true, activeMatchesDesired: false }, pack: pack(), now: NOW })
    expect(inactive.missing).toContain('the expected Wake Logger route is not active')
    const conflict = offlineReadiness({ course, acknowledgement, native: { available: true, activeMatchesDesired: false, conflict: true }, pack: pack(), now: NOW })
    expect(conflict.missing).toContain('another application owns the active route')
    const unavailable = offlineReadiness({ course, acknowledgement, native: { available: false, activeMatchesDesired: false }, pack: pack(), now: NOW })
    expect(unavailable.missing).toContain('native Signal K course services are unavailable')
  })

  it('immediately invalidates an older pack when the selected course changes', () => {
    const oldPack = pack({ courseDefinitionDigest: 'b'.repeat(64), applicable: false })
    const result = offlineReadiness({ course, acknowledgement, native, pack: oldPack, now: NOW })
    expect(result.ready).toBe(false)
    expect(result.missing).toContain('the stored Race Pack does not match the selected course')
    // The immutable pack is still reported as stored, just never ready.
    expect(result.checks.racePackReady).toBe(true)
    expect(result.checks.racePackMatches).toBe(false)
  })

  it('is not ready for an expired or unsupported pack', () => {
    const expired = offlineReadiness({ course, acknowledgement, native, pack: pack({ currentAt: 'expired' }), now: NOW })
    expect(expired.ready).toBe(false)
    expect(expired.missing).toContain('the Race Pack forecast has expired')
    const unknown = offlineReadiness({ course, acknowledgement, native, pack: pack({ currentAt: 'unknown' }), now: NOW })
    expect(unknown.missing).toContain('the Race Pack forecast validity does not cover the race')
    const unsupported = offlineReadiness({ course, acknowledgement, native, pack: pack({ ruleSetVersion: 'race_plan_preview_v1' }), now: NOW })
    expect(unsupported.missing.join(' ')).toMatch(/rule set race_plan_preview_v1 is not supported/)
  })

  it('reports no Race Pack separately from a mismatched one', () => {
    const missing = offlineReadiness({ course, acknowledgement, native, pack: null, now: NOW })
    expect(missing.missing).toContain('no Race Pack has been prepared for this course')
  })
})
