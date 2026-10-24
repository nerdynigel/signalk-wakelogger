import { describe, expect, it } from 'vitest'
import { GuidanceEngine, guidanceBearings, type GuidanceInput, type Reading } from '../src/guidance/core'
import { GuidanceService } from '../src/guidance/service'
import { parseConfig } from '../src/config/defaults'
const epoch = Date.parse('2026-10-24T00:00:00Z')
const reading = (value: number, at = epoch, source = 'boat'): Reading => ({ value, at, source })
const frame = (offset = 0, heading = 330, wind = 0): GuidanceInput => ({ at: epoch + offset,
  heading: reading(heading, epoch + offset), wind: { east: 12 * Math.sin(wind * Math.PI / 180), north: 12 * Math.cos(wind * Math.PI / 180), at: epoch + offset, source: 'wind' } })
const angleError = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

describe('source-clock guidance filtering', () => {
  it('averages across north without inventing a southerly heading', () => {
    const engine = new GuidanceEngine(); engine.update(frame(0, 359)); const result = engine.update(frame(1000, 1))!
    expect(result.headingDeg > 359 || result.headingDeg < 1).toBe(true)
  })
  it('filters wind vectors, not degree values, and reduces small oscillations', () => {
    const engine = new GuidanceEngine(); const raw: number[] = [], smooth: number[] = []
    for (let i = 0; i < 200; i++) { const wind = i % 2 ? 8 : -8; raw.push(wind); smooth.push(engine.update(frame(i * 100, 330, wind))!.windFromDeg!) }
    const movement = (x: number[]) => x.slice(31).reduce((n, a, i) => n + angleError(a, x[i + 30]!), 0)
    expect(movement(smooth)).toBeLessThan(movement(raw) * 0.5)
  })
  it('does not refilter duplicate source observations during repeated polls', () => {
    const engine = new GuidanceEngine(); engine.update(frame()); const changed = frame(1000, 335, 10)
    const first = engine.update(changed)!
    for (let i = 1; i <= 10; i++) { const next = engine.update({ ...changed, at: epoch + 1000 + i * 1000 })!; expect(next.headingDeg).toBe(first.headingDeg); expect(next.windFromDeg).toBe(first.windFromDeg); expect(next.headingValidUntil).toBe(first.headingValidUntil) }
  })
  it('rejects out of order frames and expires genuine old sources', () => {
    const engine = new GuidanceEngine(); const latest = engine.update(frame(1000))!; expect(engine.update(frame())?.headingDeg).toBe(latest.headingDeg)
    expect(engine.update({ ...frame(1000), at: epoch + 31001 })).toBeNull()
  })
  it('reseeds after a source switch or a source gap', () => {
    const engine = new GuidanceEngine(); engine.update(frame()); const changed = frame(1000, 350); changed.heading!.source = 'new-compass'; expect(engine.update(changed)?.headingDeg).toBe(350)
    expect(engine.update(frame(20000, 30))?.headingDeg).toBeCloseTo(30)
  })
  it('responds to a real turn without averaging opposite tacks', () => {
    const engine = new GuidanceEngine(); engine.update(frame()); const turn = engine.update(frame(1000, 30))!
    expect(turn.turning).toBe(true); expect(turn.kind).toBeNull(); expect(turn.headingDeg).toBeCloseTo(30)
    const settled = engine.update(frame(3000, 30))!; expect(settled.kind).toBe('tack'); expect(settled.currentTack).toBe('port')
  })
  it('uses sustained rate of turn to accelerate heading response', () => {
    const engine = new GuidanceEngine(); engine.update(frame()); let last
    for (let i = 1; i <= 30; i++) last = engine.update({ ...frame(i * 100, 330 + i * 0.6), rateOfTurn: reading(6, epoch + i * 100) })!
    expect(last!.turning).toBe(true); expect(angleError(last!.headingDeg, 348)).toBeLessThan(3)
  })
  it('clears optional invalid readings without treating them as zero', () => {
    const engine = new GuidanceEngine(); const result = engine.update({ ...frame(), rudder: reading(NaN), leeway: reading(99), stw: reading(-1) })!
    expect(result.inputs.rudder).toBeUndefined(); expect(result.leewayBasis).toBe('unavailable'); expect(result.waterSpeedKn).toBeNull(); expect(guidanceBearings(result, epoch).kind).toBe('tack')
  })
})

describe('current, leeway and steering vectors', () => {
  const currentFrame = (east = 2, north = 0): GuidanceInput => ({ ...frame(0, 0, 290), stw: reading(5), current: { east, north, at: epoch, source: 'current-meter' } })
  it('preserves bow heading and corrects ground track with cross current', () => {
    const snapshot = new GuidanceEngine().update(currentFrame())!, guides = guidanceBearings(snapshot, epoch, { targetBearingDeg: 0 })
    expect(guides.headingDeg).toBe(0); expect(guides.currentCourseDeg).toBeCloseTo(Math.atan2(2, 5) * 180 / Math.PI)
    expect(guides.courseToSteerDeg).toBeCloseTo(360 - Math.asin(2 / 5) * 180 / Math.PI)
    expect(guides.corrected).toBe(true); expect(snapshot.leewayDeg).toBeNull()
  })
  it('does not turn heading/COG difference into current without leeway calibration', () => {
    const snapshot = new GuidanceEngine().update({ ...frame(), stw: reading(5), sog: reading(6), cog: reading(350) })!
    expect(snapshot.currentBasis).toBe('unavailable'); expect(snapshot.currentEastKn).toBeNull(); expect(guidanceBearings(snapshot, epoch).currentCourseDeg).toBe(snapshot.headingDeg)
  })
  it('derives set/drift from independently known water velocity', () => {
    const east = 2 + 5 * Math.tan(3 * Math.PI / 180), north = 5
    const snapshot = new GuidanceEngine().update({ ...frame(0, 0, 290), stw: reading(5), leeway: reading(3), sog: reading(Math.hypot(east, north)), cog: reading(Math.atan2(east, north) * 180 / Math.PI) })!
    expect(snapshot.currentBasis).toBe('derived'); expect(snapshot.currentEastKn).toBeCloseTo(2, 5); expect(snapshot.currentNorthKn).toBeCloseTo(0, 5)
  })
  it('rejects an impossible cross-current steering solution', () => {
    const snapshot = new GuidanceEngine().update(currentFrame(6))!
    expect(guidanceBearings(snapshot, epoch, { targetBearingDeg: 0 }).courseToSteerDeg).toBeNull()
  })
  it('never directs a sailing boat straight through the no-go zone', () => {
    const snapshot = new GuidanceEngine().update(currentFrame())!
    expect(guidanceBearings(snapshot, epoch, { targetBearingDeg: snapshot.waterWindFromDeg }).courseToSteerDeg).toBeNull()
  })
  it('expires current independently while preserving fresh bow heading', () => {
    const snapshot = new GuidanceEngine().update(currentFrame())!; snapshot.currentValidUntil = epoch + 100
    expect(guidanceBearings(snapshot, epoch + 101).corrected).toBe(false)
    expect(guidanceBearings(snapshot, epoch + 101).headingDeg).toBe(0)
  })
  it('does not produce an intersection bearing at nearly zero ground velocity', () => {
    const snapshot = new GuidanceEngine().update(currentFrame(0, -5))!; snapshot.kind = 'tack'; snapshot.currentTack = 'port'
    expect(guidanceBearings(snapshot, epoch).currentCourseDeg).toBeNull()
  })
})

describe('optional calibrated rudder support', () => {
  const calibration = { id: 'validated-boat', validated: true as const, heelCoefficient: 10, rudderCoefficient: 0.2 }
  it('has a complete rudder-free heel/STW fallback', () => {
    const frameData = { ...frame(), stw: reading(5), heel: reading(10) }
    const without = new GuidanceEngine({ calibration }).update(frameData)!
    const withRudder = new GuidanceEngine({ calibration }).update({ ...frameData, rudder: reading(2) })!
    expect(without.leewayBasis).toBe('calibrated-heel'); expect(without.leewayDeg).toBeCloseTo(4)
    expect(withRudder.leewayBasis).toBe('calibrated-rudder'); expect(withRudder.leewayDeg).toBeCloseTo(4.4)
  })
  it('uses measured leeway ahead of a rudder model', () => {
    const snapshot = new GuidanceEngine({ calibration }).update({ ...frame(), stw: reading(5), heel: reading(10), rudder: reading(2), leeway: reading(1) })!
    expect(snapshot.leewayBasis).toBe('measured'); expect(snapshot.leewayDeg).toBeCloseTo(1)
  })
  it('does not reuse stale rudder and recovers smoothly when it returns', () => {
    const engine = new GuidanceEngine({ calibration }); engine.update({ ...frame(), stw: reading(5), heel: reading(10), rudder: reading(2) })
    const stale = engine.update({ ...frame(31000), stw: reading(5, epoch + 31000), heel: reading(10, epoch + 31000), rudder: reading(2) })!
    expect(stale.leewayBasis).toBe('calibrated-heel'); expect(stale.inputs.rudder).toBeUndefined(); expect(stale.leewayDeg).toBeCloseTo(4)
    const restored = engine.update({ ...frame(32000), stw: reading(5, epoch + 32000), heel: reading(10, epoch + 32000), rudder: reading(2, epoch + 32000) })!
    expect(restored.leewayBasis).toBe('calibrated-rudder'); expect(restored.leewayDeg).toBeGreaterThan(4); expect(restored.leewayDeg).toBeLessThan(4.4)
  })
  it('accepts bounded explicit calibration but never invents coefficients', () => {
    expect(parseConfig({}).guidance).toBeUndefined()
    expect(parseConfig({ guidance: { calibration: { ...calibration, validated: false } } }).guidance?.calibration).toBeUndefined()
    expect(parseConfig({ guidance: { calibration } }).guidance?.calibration?.rudderCoefficient).toBe(0.2)
  })
})

describe('Signal K source bridge', () => {
  it('keeps the canonical filter stable when session-aware samples interleave deltas', () => {
    const service = new GuidanceService()
    const ingest = (offset: number, heading: number) => service.ingest({ updates: [{ timestamp: new Date(epoch + offset).toISOString(), values: [{ path: 'navigation.headingTrue', value: heading * Math.PI / 180 }] }] } as never, epoch + offset)
    ingest(0, 330); service.snapshot(epoch, 'trip'); ingest(1000, 335)
    const one = service.snapshot(epoch + 1000, 'trip')!; ingest(2000, 335)
    const two = service.snapshot(epoch + 2000, 'trip')!; expect(one.headingDeg).toBeGreaterThan(330); expect(two.headingDeg).toBeGreaterThan(one.headingDeg); expect(two.headingDeg).toBeLessThan(335)
  })
  it('does not promote target rudder commands or unknown source clocks', () => {
    const service = new GuidanceService(); service.ingest({ updates: [{ values: [{ path: 'navigation.headingTrue', value: 1 }] }] } as never, epoch)
    expect(service.snapshot(epoch)).toBeNull()
    service.ingest({ updates: [{ timestamp: new Date(epoch).toISOString(), values: [{ path: 'navigation.headingTrue', value: 1 }, { path: 'steering.rudderAngleTarget', value: 0.1 }] }] } as never, epoch)
    expect(service.snapshot(epoch)?.inputs.rudder).toBeUndefined()
  })
})

it('uses explicitly validated vessel polar targets without moving the measured heading', () => {
  const engine = new GuidanceEngine({ polar: { id: 'boat', validated: true, points: [
    { twsKn: 8, upwindTwaDeg: 40, upwindSpeedKn: 4, downwindTwaDeg: 145, downwindSpeedKn: 5 },
    { twsKn: 16, upwindTwaDeg: 44, upwindSpeedKn: 6, downwindTwaDeg: 155, downwindSpeedKn: 7 }
  ] } })
  const snapshot = engine.update(frame())!, guides = guidanceBearings(snapshot, epoch)
  expect(guides.headingDeg).toBe(330); expect(snapshot.targetTwaDeg).toBeCloseTo(42); expect(guides.oppositeHeadingDeg).toBeCloseTo(42); expect(guides.currentCourseDeg).toBeCloseTo(318)
})

it('uses rudder as corroborating evidence without treating rudder alone as a turn', () => {
  const withRudder = new GuidanceEngine(), without = new GuidanceEngine()
  let a, b
  for (let i = 0; i <= 20; i++) {
    const f = { ...frame(i * 100, 330 + i * 0.2), rateOfTurn: reading(2, epoch + i * 100) }
    a = withRudder.update({ ...f, rudder: reading(5, epoch + i * 100) })
    b = without.update(f)
  }
  expect(a!.turning).toBe(true); expect(b!.turning).toBe(false)
  expect(new GuidanceEngine().update({ ...frame(), rudder: reading(20), rateOfTurn: reading(0) })?.turning).toBe(false)
})

it('reconciles complete REST snapshots so removed or unknown-clock sensors expire immediately', () => {
  const service = new GuidanceService(), stamp = new Date(epoch).toISOString(), measurement = (value: number) => ({ value, timestamp: stamp })
  const navigation = { headingTrue: measurement(330 * Math.PI / 180) }, environment = { wind: { speedOverGround: measurement(6), directionTrue: measurement(0) } }
  service.seedRest(navigation, environment, {}, epoch)
  expect(service.snapshot(epoch)?.kind).toBe('tack')
  service.seedRest(navigation, {}, {}, epoch + 1)
  expect(service.snapshot(epoch + 1)?.windFromDeg).toBeNull()
  service.seedRest({ headingMagnetic: measurement(1) }, environment, {}, epoch + 2)
  expect(service.snapshot(epoch + 2)).toBeNull()
  service.seedRest({ headingTrue: { value: 1 } }, environment, {}, epoch + 3)
  expect(service.snapshot(epoch + 3)).toBeNull()
})

it('withholds steady-sailing predictions during extreme measured motion without losing bow heading', () => {
  const engine = new GuidanceEngine(); const snapshot = engine.update({ ...frame(), heel: reading(50), pitch: reading(35) })!
  expect(snapshot.motionUnstable).toBe(true); expect(snapshot.inputs.pitch?.value).toBe(35)
  const guide = guidanceBearings(snapshot, epoch); expect(guide.headingDeg).toBe(330); expect(guide.oppositeCourseDeg).toBeNull()
  const recovered = engine.update(frame(1000))!; expect(recovered.motionUnstable).toBe(false); expect(guidanceBearings(recovered, epoch + 1000).kind).toBe('tack')
})


describe('one published sailing wind and leeway course', () => {
  it('uses water wind for instruments and mirrored guidance while retaining ground wind', () => {
    const input = { ...frame(0, 102, 138), waterWind: { east: 15.6 * Math.sin(132 * Math.PI / 180), north: 15.6 * Math.cos(132 * Math.PI / 180), at: epoch, source: 'water' } }
    const snapshot = new GuidanceEngine().update(input)!, guide = guidanceBearings(snapshot, epoch)
    expect(snapshot.windFromDeg).toBe(138); expect(snapshot.sailingWindFromDeg).toBe(132)
    expect(guide.trueWindFromDeg).toBe(132); expect(guide.oppositeHeadingDeg).toBe(162)
    expect(snapshot.sailingWindBasis).toBe('water'); expect(guide.waterCourseDeg).toBeNull()
  })
  it('derives water wind without GPS and removes measured water motion including leeway', () => {
    const input: GuidanceInput = { at: epoch, heading: reading(0), stw: reading(5), leeway: reading(3),
      apparentWind: { east: 8, north: 10, at: epoch, source: 'mast' } }
    const s = new GuidanceEngine().update(input)!
    const east = 8 - 5 * Math.tan(3 * Math.PI / 180), north = 5
    expect(s.sailingWindBasis).toBe('water'); expect(s.windFromDeg).toBeNull()
    expect(s.sailingWindFromDeg).toBeCloseTo(Math.atan2(east, north) * 180 / Math.PI, 5)
    expect(s.sailingWindSpeedKn).toBeCloseTo(Math.hypot(east, north), 5)
  })
  it('does not refresh water wind from new GPS or reuse a missing speed input', () => {
    const engine = new GuidanceEngine(), first = { ...frame(), stw: reading(5), apparentWind: { east: 8, north: 10, at: epoch, source: 'mast' } }
    const s = engine.update(first)!
    expect(engine.update({ ...first, at: epoch + 1000, sog: reading(20, epoch + 1000) })?.sailingWindAt).toBe(s.sailingWindAt)
    const fallback = engine.update({ ...frame(31000), stw: reading(5), apparentWind: first.apparentWind })!
    expect(fallback.sailingWindBasis).toBe('ground')
    const restored = engine.update({ ...frame(32000), stw: reading(5, epoch + 32000), apparentWind: { ...first.apparentWind, at: epoch + 32000 } })!
    expect(restored.sailingWindBasis).toBe('water')
  })
  it('filters selected water vectors and never adds current to them a second time', () => {
    const engine = new GuidanceEngine(), input = { ...frame(), stw: reading(5), current: { east: 2, north: 0, at: epoch }, waterWind: { east: 0, north: 12, at: epoch, source: 'water' } }
    const first = engine.update(input)!, a = guidanceBearings(first, epoch)
    expect(a.trueWindFromDeg).toBe(0); expect(a.trueWindSpeedKn).toBe(12)
    const s = engine.update({ ...input, at: epoch + 1000, heading: reading(330, epoch + 1000), waterWind: { east: 6, north: 12, at: epoch + 1000, source: 'water' } })!
    expect(s.sailingWindFromDeg).toBeGreaterThan(0); expect(s.sailingWindFromDeg).toBeLessThan(Math.atan2(6, 12) * 180 / Math.PI)
    const repeated = engine.update({ ...input, at: epoch + 2000, waterWind: { east: 6, north: 12, at: epoch + 1000, source: 'water' } })!
    expect(repeated.sailingWindFromDeg).toBe(s.sailingWindFromDeg)
  })
  for (const leeway of [-3, 3]) it(`separates heading, water course and current-corrected ground course for leeway ${leeway}`, () => {
    const s = new GuidanceEngine().update({ ...frame(0, 0, 290), stw: reading(5), leeway: reading(leeway), current: { east: 2, north: 0, at: epoch } })!
    const g = guidanceBearings(s, epoch)
    expect(g.headingDeg).toBe(0); expect(g.waterCourseDeg).toBe((leeway + 360) % 360)
    expect(g.currentCourseDeg).toBeCloseTo(Math.atan2(2 + 5 * Math.tan(leeway * Math.PI / 180), 5) * 180 / Math.PI)
    expect(g.currentCourseDeg).not.toBe(g.waterCourseDeg)
    expect(guidanceBearings({ ...s, leewayAt: epoch - 31000 }, epoch).waterCourseDeg).toBeNull()
    expect(guidanceBearings({ ...s, turning: true }, epoch).waterCourseDeg).toBeNull()
    expect(guidanceBearings({ ...s, motionUnstable: true }, epoch).waterCourseDeg).toBeNull()
  })
  it('uses a fresh measured leeway direction without requiring GPS or water speed', () => {
    const s = new GuidanceEngine().update({ ...frame(), leeway: reading(-3) })!
    const g = guidanceBearings(s, epoch)
    expect(g.waterCourseDeg).toBe(327); expect(g.currentCourseDeg).toBe(327); expect(g.corrected).toBe(true)
  })
})


it('drops expired leeway from a polar steering solution while retaining fresh current', () => {
  const s = new GuidanceEngine().update({ ...frame(0, 0, 290), stw: reading(5), leeway: reading(6), current: { east: 2, north: 0, at: epoch } })!
  s.targetTwaDeg = 40; s.targetSpeedKn = 5; s.leewayAt = epoch - 31000
  expect(guidanceBearings(s, epoch, { targetBearingDeg: 0 }).courseToSteerDeg).toBeCloseTo(360 - Math.asin(2 / 5) * 180 / Math.PI)
})
