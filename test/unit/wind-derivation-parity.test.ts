import { beforeAll, describe, expect, it } from 'vitest'
import { deriveTrueWindSample } from '../../src/race/observation-window'

// The browser module is plain ESM without type declarations; load it through a
// runtime path so this test can prove the two implementations are identical.
const browserPath: string = '../../webapp/wind-derivation.mjs'
let browserDerive: (sample: Record<string, unknown>) => unknown
beforeAll(async () => {
  const browserModule = await import(browserPath)
  browserDerive = browserModule.deriveTrueWindSample
})

const cases: Array<Record<string, unknown>> = [
  { twsKnots: 14, twdDeg: 45 },
  { awsKnots: 18.7, awaDeg: 31.9, headingDeg: 0, stwKnots: 6 },
  { awsKnots: 18.7, awaDeg: 31.9, cogDeg: 10, sogKnots: 6 },
  { awsKnots: 10, awaDeg: -45, headingDeg: 200, sogKnots: 5, stwKnots: 4.5 },
  { awsKnots: 22, apparentDirectionDeg: 210, cogDeg: 30, sogKnots: 8 },
  { awsKnots: 12, awaDeg: 170, headingDeg: 90, sogKnots: 0.2 },
  { awsKnots: 0, awaDeg: 0, headingDeg: 0, sogKnots: 0 },
  { awsKnots: 12, awaDeg: 45 },
  { awsKnots: 12, headingDeg: Number.NaN, cogDeg: Number.NaN, sogKnots: 5, awaDeg: 30 },
  { twsKnots: 8, twdDeg: 359.9 },
  { awsKnots: 12, awaDeg: -180, headingDeg: 359, sogKnots: 3 }
]

describe('browser wind derivation matches the shared plugin engine', () => {
  for (const [index, input] of cases.entries()) {
    it(`case ${index} is identical`, () => {
      const plugin = deriveTrueWindSample(input as Parameters<typeof deriveTrueWindSample>[0])
      const browser = browserDerive(input)
      if (plugin === null) {
        expect(browser).toBeNull()
        return
      }
      expect(browser).toEqual({ twsKnots: plugin.twsKnots, twdDeg: plugin.twdDeg, direct: plugin.direct })
    })
  }
})
