import { describe, expect, it } from 'vitest'
import { ObservationCollector, observationReadiness } from '../../src/race/observations'

const KNOTS = 1.9438444924406
const BASE = Date.parse('2026-09-17T02:00:00Z')

function delta(): never {
  return { updates: [{ timestamp: new Date(BASE).toISOString(), values: [
    { path: 'navigation.position', value: { latitude: -27.395, longitude: 153.18 } },
    { path: 'navigation.speedOverGround', value: 6 / KNOTS },
    { path: 'navigation.courseOverGroundTrue', value: 10 * Math.PI / 180 },
    { path: 'navigation.headingTrue', value: 10 * Math.PI / 180 },
    { path: 'environment.wind.speedTrue', value: 14 / KNOTS },
    { path: 'environment.wind.directionTrue', value: 45 * Math.PI / 180 }
  ] }] } as never
}

function collector(clock: { value: number }): ObservationCollector {
  return new ObservationCollector(5 * 60 * 1000, () => clock.value)
}

function ingestWindow(observations: ObservationCollector, clock: { value: number }, count: number, intervalMs: number, endAt: number): void {
  for (let index = count - 1; index >= 0; index -= 1) {
    clock.value = endAt - index * intervalMs
    observations.ingest(delta())
  }
  clock.value = endAt
}

describe('shared observation readiness contract', () => {
  it('is not ready with only three fresh samples', () => {
    const clock = { value: BASE }
    const observations = collector(clock)
    ingestWindow(observations, clock, 3, 60_000, BASE)
    const result = observations.observations(BASE)
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.reason).toBe('too_few_samples')
  })

  it('is not ready when 30 samples are compressed into 30 seconds', () => {
    const clock = { value: BASE }
    const observations = collector(clock)
    // The collector's 5 s throttle collapses a burst; even ignoring it, a 30 s
    // span is below the 240 s minimum.
    ingestWindow(observations, clock, 30, 1_000, BASE)
    const result = observations.observations(BASE)
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.coveredSeconds).toBeLessThan(240)
    // A synthetic window with enough samples but a short span fails on span.
    const synthetic = observationReadiness({
      twsKnots: 14, twdDeg: 45, gustKnots: 17, headingDeg: 10, cogDeg: 10, sogKnots: 6, stwKnots: null, heelDeg: null,
      awsKnots: null, awaDeg: null, sampleCount: 30, windowSeconds: 300, windSource: 'true',
      qualifyingSampleCount: 30, coveredSeconds: 30, latestSampleAgeSeconds: 0
    }, { latitude: -27.4, longitude: 153.17 })
    expect(synthetic.reason).toBe('span_too_short')
  })

  it('becomes ready with enough samples across roughly four to five minutes', () => {
    const clock = { value: BASE }
    const observations = collector(clock)
    ingestWindow(observations, clock, 30, 9_000, BASE)
    const result = observations.observations(BASE)
    expect(result.readiness.ready).toBe(true)
    expect(result.readiness.reason).toBe('ready')
    expect(result.readiness.coveredSeconds).toBeGreaterThanOrEqual(240)
    expect(result.readiness.coveredSeconds).toBeLessThanOrEqual(300)
    expect(result.readiness.qualifyingSampleCount).toBe(30)
  })

  it('is not ready when the newest observation is stale', () => {
    const clock = { value: BASE }
    const observations = collector(clock)
    ingestWindow(observations, clock, 30, 9_000, BASE)
    expect(observations.observations(BASE).readiness.ready).toBe(true)
    // 45 s later the wind window still spans enough time but the newest
    // qualifying wind sample is older than the 30 s freshness bound. Refresh
    // only the position so freshness, not position, is the deciding factor.
    clock.value = BASE + 35_000
    observations.ingest({ updates: [{ timestamp: new Date(clock.value).toISOString(), values: [
      { path: 'navigation.position', value: { latitude: -27.395, longitude: 153.18 } }
    ] }] } as never)
    const stale = observations.observations(clock.value)
    expect(stale.readiness.ready).toBe(false)
    expect(stale.readiness.reason).toBe('stale')
  })

  it('is not ready without a valid vessel position', () => {
    const clock = { value: BASE }
    const observations = collector(clock)
    for (let index = 29; index >= 0; index -= 1) {
      clock.value = BASE - index * 9_000
      observations.ingest({ updates: [{ timestamp: new Date(clock.value).toISOString(), values: [
        { path: 'navigation.speedOverGround', value: 6 / KNOTS },
        { path: 'navigation.headingTrue', value: 10 * Math.PI / 180 },
        { path: 'environment.wind.speedTrue', value: 14 / KNOTS },
        { path: 'environment.wind.directionTrue', value: 45 * Math.PI / 180 }
      ] }] } as never)
    }
    clock.value = BASE
    const result = observations.observations(BASE)
    expect(result.position).toBeNull()
    expect(result.readiness.ready).toBe(false)
    expect(result.readiness.reason).toBe('no_position')
  })

  it('rebuilds readiness safely after a restart', () => {
    const clock = { value: BASE }
    const first = collector(clock)
    ingestWindow(first, clock, 30, 9_000, BASE)
    expect(first.observations(BASE).readiness.ready).toBe(true)

    // A restarted collector has no in-memory history and must not claim a
    // window it never observed.
    const restarted = collector(clock)
    clock.value = BASE + 1_000
    expect(restarted.observations(clock.value).readiness.ready).toBe(false)
    ingestWindow(restarted, clock, 30, 9_000, BASE + 262_000)
    expect(restarted.observations(clock.value).readiness.ready).toBe(true)
  })
})
