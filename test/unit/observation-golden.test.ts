import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveTrueWind, observationReadiness } from '../../src/race/observations'
import type { SailingAverages } from '../../src/race/averages'

// Byte-identical with nerdynigel/wakelogger
// api/tests/fixtures/race_pack/observation_golden.json.
export const OBSERVATION_GOLDEN_SHA256 = 'ae3edb54dd6c2393354da137d6ede483d8c352a51a4cadc9710e58d0cb0edf5b'

const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'observation_golden.json'), 'utf8'))

describe('shared observation golden', () => {
  it('is byte-identical across repositories', () => {
    const bytes = readFileSync(path.join(__dirname, '..', 'fixtures', 'observation_golden.json'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(OBSERVATION_GOLDEN_SHA256)
  })

  it('derives true wind identically around north on both engines', () => {
    const { twsKnots: twsTolerance, twdDeg: twdTolerance } = FIXTURE.tolerances
    for (const item of FIXTURE.apparentToTrue) {
      const derived = deriveTrueWind({
        headingDeg: item.headingDeg, courseDeg: item.cogDeg, sogKnots: item.sogKnots, stwKnots: item.stwKnots, awaDeg: item.awaDeg, awsKnots: item.awsKnots
      })
      expect(derived, item.name).not.toBeNull()
      expect(Math.abs(derived!.twsKnots - item.expected.twsKnots), item.name).toBeLessThanOrEqual(twsTolerance)
      expect(Math.abs(derived!.twdDeg - item.expected.twdDeg), item.name).toBeLessThanOrEqual(twdTolerance)
    }
  })

  it('applies the shared readiness contract thresholds', () => {
    expect(FIXTURE.readiness.windowSeconds).toBe(300)
    expect(FIXTURE.readiness.minSpanSeconds).toBe(240)
    expect(FIXTURE.readiness.minSamples).toBe(30)
    expect(FIXTURE.readiness.maxAgeSeconds).toBe(30)
    for (const item of FIXTURE.readiness.cases) {
      const averages: SailingAverages = {
        twsKnots: item.wind ? 14 : null, twdDeg: item.wind ? 45 : null,
        headingDeg: 10, cogDeg: 10, sogKnots: 6, stwKnots: null, heelDeg: null, awsKnots: null, awaDeg: null,
        sampleCount: item.qualifyingSampleCount, windowSeconds: 300, windSource: item.wind ? 'true' : null,
        qualifyingSampleCount: item.qualifyingSampleCount, coveredSeconds: item.coveredSeconds, latestSampleAgeSeconds: item.latestSampleAgeSeconds
      }
      const position = item.position ? { latitude: -27.4, longitude: 153.17 } : null
      const readiness = observationReadiness(averages, position)
      expect(readiness.reason, item.name).toBe(item.expected)
      expect(readiness.ready, item.name).toBe(item.expected === 'ready')
    }
  })
})
