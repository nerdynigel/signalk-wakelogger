import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeDynamicPlan } from '../../src/race/dynamic'

// Byte-identical with nerdynigel/wakelogger
// api/tests/fixtures/race_pack/dynamic_golden.json. The cloud test suite asserts
// the same SHA and runs the same scenario through its Python engine.
export const DYNAMIC_GOLDEN_FIXTURE_SHA256 = '7c6ad12a67dd3f06d59448961c53dfbb45ac1f2abed6809b057830f363b436ad'
export const DYNAMIC_GOLDEN_EXPECTED_SHA256 = 'edc1d4de8c7d2de6b170753f45f0b288191ef5afee2ade1b03b2b6f30a4ad746'

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures')
const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'dynamic_golden.json'), 'utf8'))
const expected = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'dynamic_golden.expected.json'), 'utf8'))

const TIMESTAMP = /(Eta|At)$/

function compare(actual: unknown, expectedValue: unknown, trail: string, differences: string[]): void {
  if (typeof expectedValue === 'number' && typeof actual === 'number') {
    const tolerance = trail.endsWith('legDurationSeconds') ? 2 : trail.endsWith('remainingDurationSeconds') ? 2 : Math.max(1e-6, Math.abs(expectedValue) * 1e-9)
    if (Math.abs(actual - expectedValue) > tolerance) differences.push(`${trail}: ${actual} != ${expectedValue} (>${tolerance})`)
    return
  }
  if (typeof expectedValue === 'string' && typeof actual === 'string' && TIMESTAMP.test(trail)) {
    const delta = Math.abs(Date.parse(actual) - Date.parse(expectedValue))
    if (!Number.isFinite(delta) || delta > 1500) differences.push(`${trail}: ${actual} != ${expectedValue}`)
    return
  }
  if (Array.isArray(expectedValue) && Array.isArray(actual)) {
    if (actual.length !== expectedValue.length) { differences.push(`${trail}: length ${actual.length} != ${expectedValue.length}`); return }
    for (let index = 0; index < expectedValue.length; index += 1) compare(actual[index], expectedValue[index], `${trail}[${index}]`, differences)
    return
  }
  if (expectedValue && typeof expectedValue === 'object' && actual && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expectedValue as Record<string, unknown>), ...Object.keys(actual as Record<string, unknown>)])
    for (const key of keys) compare((actual as Record<string, unknown>)[key], (expectedValue as Record<string, unknown>)[key], trail ? `${trail}.${key}` : key, differences)
    return
  }
  if (actual !== expectedValue) differences.push(`${trail}: ${JSON.stringify(actual)} != ${JSON.stringify(expectedValue)}`)
}

describe('shared dynamic golden scenario', () => {
  it('is byte-identical across repositories', () => {
    const bytes = readFileSync(path.join(FIXTURE_DIR, 'dynamic_golden.json'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(DYNAMIC_GOLDEN_FIXTURE_SHA256)
    const expectedBytes = readFileSync(path.join(FIXTURE_DIR, 'dynamic_golden.expected.json'))
    expect(createHash('sha256').update(expectedBytes).digest('hex')).toBe(DYNAMIC_GOLDEN_EXPECTED_SHA256)
  })

  it('reproduces the committed cloud/onboard golden output within narrow tolerances', () => {
    const actual = computeDynamicPlan(fixture)
    const differences: string[] = []
    compare(actual, expected, '', differences)
    expect(differences).toEqual([])
  })

  it('starts the active leg at the live vessel position and keeps future legs mark-to-mark', () => {
    const plan = computeDynamicPlan(fixture)
    expect(plan.completedLegCount).toBe(1)
    expect(plan.activeLegSequence).toBe(2)
    const active = plan.legs[0]!
    expect(active.fromVesselPosition).toBe(true)
    expect(active.from).toMatchObject({ latitude: -27.372, longitude: 153.22 })
    // ~70-80% through the leg: the remaining distance is far shorter than the mark-to-mark leg.
    expect(active.distanceNm).toBeLessThan(active.markToMarkDistanceNm * 0.5)
    expect(active.markToMarkDistanceNm).toBeGreaterThan(2)
    expect(plan.legs[1]!.fromVesselPosition).toBe(false)
  })

  it('uses selected vessel wind on all remaining legs', () => {
    const plan = computeDynamicPlan(fixture)
    expect(plan.legs[0]!.conditions.source).toBe('observed')
    expect(plan.legs[0]!.conditions.twsKnots).toBeCloseTo(13.4, 5)
    expect(plan.legs[0]!.conditions.currentVelocityKn).not.toBeNull()
    expect(plan.legs[1]!.conditions.source).toBe('observed')
    expect(plan.legs[1]!.conditions.twsKnots).toBe(plan.legs[0]!.conditions.twsKnots)
    expect(plan.legs[1]!.conditions.twdDeg).toBe(plan.legs[0]!.conditions.twdDeg)
    expect(plan.legs.every((leg) => leg.conditions.source === 'observed')).toBe(true)
  })

  it('delays a future leg onto a different forecast sample than the original schedule', () => {
    const plan = computeDynamicPlan(fixture)
    const third = plan.legs.find((leg) => leg.sequence === 3)!
    expect(third.selectedForecastSampleTime).toBe('2026-06-14T03:00:00Z')
    expect(third.conditions.twsKnots).toBe(fixture.observed.twsKnots)

    // The original all-marks schedule computed from the race start (no actual
    // progress, no observations) lands on a different hourly sample, proving
    // the recalculated ETA moves forecast selection.
    const original = computeDynamicPlan({ ...fixture, activeIndex: 1, observed: null, position: null })
    const originalThird = original.legs.find((leg) => leg.sequence === 3)!
    expect(originalThird.selectedForecastSampleTime).toBe('2026-06-14T04:00:00Z')
    expect(originalThird.conditions.twsKnots).toBe(22)
  })

  it('includes current in the estimated SOG', () => {
    const plan = computeDynamicPlan(fixture)
    const active = plan.legs[0]!
    expect(active.currentComponentKnots).not.toBeNull()
    expect(active.currentComponentKnots!).toBeLessThan(0)
    expect(active.estimatedSogKnots!).toBeLessThan(active.estimatedSpeedKnots!)
  })

  it('crosses north deterministically and is repeatable', () => {
    const first = computeDynamicPlan(fixture)
    const second = computeDynamicPlan(fixture)
    expect(second).toEqual(first)
    const sampleDirections = fixture.forecast.legs[1]!.samples.map((sample: { twd_deg: number }) => sample.twd_deg)
    expect(sampleDirections.some((direction: number) => direction > 350)).toBe(true)
    expect(sampleDirections.some((direction: number) => direction < 10)).toBe(true)
  })
  it('uses observed wind for next-leg sails and apparent estimates, falling back only without observations', () => {
    const observed = computeDynamicPlan(fixture).legs[1]!
    const forecast = computeDynamicPlan({ ...fixture, observed: null }).legs[1]!
    expect(forecast.conditions.source).toBe('forecast')
    expect(observed.awaDeg).not.toBe(forecast.awaDeg)
    expect(observed.awsKnots).not.toBe(forecast.awsKnots)
    expect(observed.plan).not.toEqual(forecast.plan)
    const noForecast = computeDynamicPlan({ ...fixture, forecast: { legs: [] } })
    expect(noForecast.legs.every(l => l.conditions.source === 'observed')).toBe(true)
    expect(noForecast.legs[1]!.awaDeg).not.toBeNull()
    expect(noForecast.legs[1]!.plan).not.toBeNull()
    const unavailable = computeDynamicPlan({ ...fixture, observed: null, forecast: { legs: [] } })
    expect(unavailable.legs[1]!.awaDeg).toBeNull()
    expect(unavailable.legs[1]!.plan).toBeNull()
  })

  it('reprojects apparent wind and sail plans on every remaining leg as vessel wind changes', () => {
    const plan = computeDynamicPlan(fixture)
    expect(plan.legs.length).toBeGreaterThan(2)
    for (const leg of plan.legs) {
      expect(leg.conditions.twdDeg).toBe(fixture.observed.twdDeg)
      expect(leg.conditions.twsKnots).toBe(fixture.observed.twsKnots)
      const angle = (fixture.observed.twdDeg - leg.bearingDeg) * Math.PI / 180
      const across = fixture.observed.twsKnots * Math.sin(angle)
      const along = fixture.observed.twsKnots * Math.cos(angle) + leg.estimatedBoatSpeedKnots!
      expect(Math.abs(leg.awaDeg! - Math.abs(Math.atan2(across, along) * 180 / Math.PI))).toBeLessThanOrEqual(0.051)
      expect(Math.abs(leg.awsKnots! - Math.hypot(across, along))).toBeLessThanOrEqual(0.011)
      expect(leg.plan).not.toBeNull()
    }
    const changed = computeDynamicPlan({ ...fixture, observed: { ...fixture.observed, twdDeg: 130, twsKnots: 22 } })
    expect(changed.legs.at(-1)!.awaDeg).not.toBe(plan.legs.at(-1)!.awaDeg)
    expect(changed.legs.at(-1)!.plan).not.toEqual(plan.legs.at(-1)!.plan)
    expect(computeDynamicPlan({ ...fixture, observed: null }).legs.every(leg => leg.conditions.source === 'forecast')).toBe(true)
  })

})
