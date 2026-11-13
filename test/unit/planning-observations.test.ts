import { describe, it, expect } from 'vitest'
import { selectPlanningObservations, type SailingAverageSample } from '../../src/race/observation-window'
import { RollingAverages } from '../../src/race/averages'

const at = 1_800_000_000_000
const sample = (seconds: number, speed: number, direction = 130): SailingAverageSample => ({ at: at + seconds * 1000, twsKnots: speed, twdDeg: direction, headingDeg: 90, sogKnots: 6 })

describe('planning wind selection', () => {
  it('uses the latest fresh sample during startup, not the partial-window mean', () => {
    const p = selectPlanningObservations([sample(0, 10), sample(60, 20), sample(120, 30)], at + 120_000)!
    expect(p.basis).toBe('latest')
    expect(p.averages.twsKnots).toBe(30)
    expect(p.averages.sampleCount).toBe(1)
  })
  it('switches at five minutes and excludes older readings from the average', () => {
    const samples = [sample(0, 100), sample(100, 10, 350), sample(290, 30, 10), sample(301, 50, 0)]
    const p = selectPlanningObservations(samples, at + 301_000)!
    expect(p.basis).toBe('five_minute_average')
    expect(p.averages.twsKnots).toBe(30)
    expect(p.averages.twdDeg).toBe(0)
  })
  it('rejects stale, future and unusable wind', () => {
    expect(selectPlanningObservations([sample(0, 10)], at + 31_000)).toBeNull()
    expect(selectPlanningObservations([sample(2, 10)], at)).toBeNull()
    expect(selectPlanningObservations([{ at, headingDeg: 90, sogKnots: 6 }], at)).toBeNull()
  })
  it('retains the five-minute history anchor after pruning and resets between trips', () => {
    const r = new RollingAverages()
    r.add(sample(0, 100))
    r.add(sample(100, 10))
    r.add(sample(290, 30))
    r.add(sample(301, 20))
    expect(r.planningValue(at + 301_000)!.basis).toBe('five_minute_average')
    expect(r.planningValue(at + 301_000)!.averages.twsKnots).toBe(20)
    r.reset()
    r.add(sample(302, 40))
    expect(r.planningValue(at + 302_000)!.basis).toBe('latest')
    expect(r.planningValue(at + 302_000)!.averages.twsKnots).toBe(40)
  })
  it('uses the newest startup reading even between aggregation ticks', () => {
    const r = new RollingAverages()
    r.add(sample(0, 10))
    r.observe(sample(1, 30))
    expect(r.planningValue(at + 1000)!.averages.twsKnots).toBe(30)
  })
})
