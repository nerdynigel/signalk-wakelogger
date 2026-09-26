import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { aggregateRawObservationWindow } from '../../src/race/observation-window'

// Byte-identical with nerdynigel/wakelogger
// api/tests/fixtures/race_pack/observation_raw_golden.json.
export const OBSERVATION_RAW_FIXTURE_SHA256 = 'bcacb68d865ea929e4b592bc67f7a83bb7d0f55734c6136424043726007d3457'
export const OBSERVATION_RAW_EXPECTED_SHA256 = 'e832227f460b2aec97ad74024c8bc28aa16016b7b36b1074b131f27a32103921'

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures')
const fixture = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'observation_raw_golden.json'), 'utf8'))
const expected = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'observation_raw_golden.expected.json'), 'utf8'))

function run() {
  const now = Date.parse(fixture.now)
  const samples = fixture.samples.map((sample: { at: string }) => ({ ...sample, at: Date.parse(sample.at) }))
  const result = aggregateRawObservationWindow(samples, now)
  return { ...result.averages, position: result.position, readiness: result.readiness }
}

describe('shared raw observation golden', () => {
  it('is byte-identical across repositories', () => {
    expect(createHash('sha256').update(readFileSync(path.join(FIXTURE_DIR, 'observation_raw_golden.json'))).digest('hex')).toBe(OBSERVATION_RAW_FIXTURE_SHA256)
    expect(createHash('sha256').update(readFileSync(path.join(FIXTURE_DIR, 'observation_raw_golden.expected.json'))).digest('hex')).toBe(OBSERVATION_RAW_EXPECTED_SHA256)
  })

  it('aggregates the raw window exactly like the shared expected values', () => {
    const actual = run()
    expect(actual.twsKnots).toBeCloseTo(expected.twsKnots, 2)
    expect(actual.twdDeg).toBeCloseTo(expected.twdDeg, 1)
    expect(actual.gustKnots).toBeCloseTo(expected.gustKnots, 2)
    expect(actual.headingDeg).toBeCloseTo(expected.headingDeg, 1)
    expect(actual.cogDeg).toBeCloseTo(expected.cogDeg, 1)
    expect(actual.sogKnots).toBeCloseTo(expected.sogKnots, 3)
    expect(actual.stwKnots).toBeCloseTo(expected.stwKnots, 3)
    expect(actual.awsKnots).toBeCloseTo(expected.awsKnots, 2)
    expect(actual.awaDeg).toBeCloseTo(expected.awaDeg, 1)
    expect(actual.sampleCount).toBe(expected.sampleCount)
    expect(actual.qualifyingSampleCount).toBe(expected.qualifyingSampleCount)
    expect(actual.coveredSeconds).toBe(expected.coveredSeconds)
    expect(actual.latestSampleAgeSeconds).toBe(expected.latestSampleAgeSeconds)
    expect(actual.windSource).toBe(expected.windSource)
    expect(actual.position).toEqual(expected.position)
    expect(actual.readiness).toMatchObject(expected.readiness)
  })

  it('uses the mean (not the median) so the deliberate outlier is included', () => {
    // The fixture contains one 30 kn TWS outlier among ~13.5 kn samples. The
    // shared rule is the arithmetic mean, so the aggregate is pulled above the
    // typical value; a median would sit near 13.5.
    const actual = run()
    expect(actual.twsKnots).toBeGreaterThan(13.6)
    expect(actual.gustKnots).toBe(34)
  })
})
