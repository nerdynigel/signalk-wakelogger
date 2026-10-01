import { describe, expect, it } from 'vitest'
import { EXPECTED_RACE_WINDOW_MS, offlineReadiness, type ReadinessPackState } from '../../src/race/readiness'

const NOW = Date.parse('2026-09-17T02:05:00Z')
const DIGEST = 'a'.repeat(64)
const COVERAGE_UNTIL = new Date(NOW + 2 * EXPECTED_RACE_WINDOW_MS).toISOString()

const course = { action: 'activate', revision: 7, courseId: 'race-42', racePlanId: 42, courseDefinitionDigest: DIGEST }
const acknowledgement = { status: 'applied', revision: 7 }
const native = { available: true, activeMatchesDesired: true, conflict: false, reverse: false }

function pack(overrides: Partial<ReadinessPackState> = {}): ReadinessPackState {
  return {
    available: true,
    revision: 4,
    ruleSetVersion: 'race_plan_dynamic_v1',
    courseId: 'race-42',
    racePlanId: 42,
    courseDefinitionDigest: DIGEST,
    validFrom: '2020-01-01T00:00:00Z',
    validUntil: '2035-01-01T00:00:00Z',
    coverage: { from: '2026-09-17T00:00:00Z', until: COVERAGE_UNTIL },
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
    expect(result.forecastCoverage).toBe('covers_expected_window')
    expect(result.packStoredNotApplicable).toBe(false)
  })

  it('treats course and pack revisions as separate namespaces', () => {
    const result = offlineReadiness({ course: { ...course, revision: 99 }, acknowledgement: { status: 'applied', revision: 99 }, native, pack: pack({ revision: 1 }), now: NOW })
    expect(result.ready).toBe(true)
  })

  it('is not ready without a selected or applied course', () => {
    const none = offlineReadiness({ course: null, acknowledgement: null, native, pack: pack(), now: NOW })
    expect(none.ready).toBe(false)
    expect(none.missing).toContain('no Wake Logger course is selected')
    const rejected = offlineReadiness({ course, acknowledgement: { status: 'rejected', revision: 7 }, native, pack: pack(), now: NOW })
    expect(rejected.missing).toContain('the selected course has not been applied')
  })

  it('is not ready when the native route is inactive, conflicted or reversed', () => {
    expect(offlineReadiness({ course, acknowledgement, native: { available: true, activeMatchesDesired: false }, pack: pack(), now: NOW }).missing).toContain('the expected Wake Logger route is not active')
    expect(offlineReadiness({ course, acknowledgement, native: { available: true, activeMatchesDesired: false, conflict: true }, pack: pack(), now: NOW }).missing).toContain('another application owns the active route')
    expect(offlineReadiness({ course, acknowledgement, native: { available: false, activeMatchesDesired: false }, pack: pack(), now: NOW }).missing).toContain('native Signal K course services are unavailable')
    // The planner refuses a reversed native course, so readiness must too.
    expect(offlineReadiness({ course, acknowledgement, native: { available: true, activeMatchesDesired: true, reverse: true }, pack: pack(), now: NOW }).missing).toContain('the active native course is reversed, which the onboard planner does not support')
  })

  it('marks an available but mismatched pack as stored, not ready', () => {
    const result = offlineReadiness({ course, acknowledgement, native, pack: pack({ courseDefinitionDigest: 'b'.repeat(64) }), now: NOW })
    expect(result.ready).toBe(false)
    expect(result.checks.racePackReady).toBe(true)
    expect(result.checks.racePackMatches).toBe(false)
    expect(result.packStoredNotApplicable).toBe(true)
    expect(result.missing).toContain('the stored Race Pack does not match the selected course')
  })

  it('is not ready for an expired, not-yet or unknown-validity pack', () => {
    expect(offlineReadiness({ course, acknowledgement, native, pack: pack({ currentAt: 'expired' }), now: NOW }).missing).toContain('the Race Pack forecast has expired')
    expect(offlineReadiness({ course, acknowledgement, native, pack: pack({ currentAt: 'not_yet' }), now: NOW }).missing).toContain('the Race Pack forecast is not yet in effect')
    const unknown = offlineReadiness({ course, acknowledgement, native, pack: pack({ currentAt: 'unknown', validFrom: null, validUntil: null, coverage: null }), now: NOW })
    expect(unknown.missing).toContain('the Race Pack has no confirmed forecast validity window')
  })

  it('distinguishes forecast-valid-now from demonstrated race-window coverage', () => {
    const short = offlineReadiness({ course, acknowledgement, native, pack: pack({ coverage: { from: '2026-09-17T00:00:00Z', until: new Date(NOW + 60 * 60 * 1000).toISOString() } }), now: NOW })
    expect(short.ready).toBe(true)
    expect(short.checks.forecastCoversRace).toBe(false)
    expect(short.forecastCoverage).toBe('valid_now_only')
    expect(short.uncertainty.join(' ')).toMatch(/does not confirm the whole race window/)
  })

  it('is not ready for an unsupported rule set or a missing pack', () => {
    expect(offlineReadiness({ course, acknowledgement, native, pack: pack({ ruleSetVersion: 'race_plan_preview_v1' }), now: NOW }).missing.join(' ')).toMatch(/rule set race_plan_preview_v1 is not supported/)
    expect(offlineReadiness({ course, acknowledgement, native, pack: null, now: NOW }).missing).toContain('no Race Pack has been prepared for this course')
  })
})
