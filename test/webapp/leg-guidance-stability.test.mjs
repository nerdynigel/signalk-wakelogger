import test from 'node:test'
import assert from 'node:assert/strict'
import { LegGuidanceStabilizer } from '../../webapp/leg-guidance-stability.mjs'
const plan = (id, config = 'full_main', warnings = []) => ({ summary: `Main + sail ${id}`, mainsail_configuration: config, mainsail: { sail_id: 10 }, headsail_or_downwind_sail: { sail_id: id }, warnings })
const leg = (awa = 20, aws = 10, selected = plan(1)) => ({ sequence: 1, to: { name: 'Top' }, awaDeg: awa, awsKnots: aws, windSide: 'port', conditions: { source: 'observed' }, plan: selected })
const update = (s, l, t, key = 'race') => s.update(key, [l], t)[0]
test('15-second EMA softens a step and does not mutate the engine output', () => {
  const s = new LegGuidanceStabilizer()
  update(s, leg(), 0)
  const raw = leg(40, 20), before = structuredClone(raw)
  const shown = update(s, raw, 15000)
  assert.ok(Math.abs(shown.awaDeg - (20 + 20 * (1 - Math.exp(-1)))) < 1e-9)
  assert.ok(shown.awsKnots > 16 && shown.awsKnots < 17)
  assert.deepEqual(raw, before)
})
test('deadbands suppress small display noise', () => {
  const s = new LegGuidanceStabilizer()
  update(s, leg(), 0)
  const shown = update(s, leg(20.7, 10.1), 15000)
  assert.equal(shown.awaDeg, 20)
  assert.equal(shown.awsKnots, 10)
})
test('a new preferred sail must persist for 30 seconds', () => {
  const s = new LegGuidanceStabilizer()
  update(s, leg(), 0)
  assert.equal(update(s, leg(20, 10, plan(2)), 1000).plan.summary, 'Main + sail 1')
  assert.equal(update(s, leg(20, 10, plan(2)), 30000).plan.summary, 'Main + sail 1')
  assert.equal(update(s, leg(20, 10, plan(2)), 31000).plan.summary, 'Main + sail 2')
})
test('an oscillating candidate restarts the hold period', () => {
  const s = new LegGuidanceStabilizer()
  update(s, leg(), 0)
  update(s, leg(20, 10, plan(2)), 1000)
  update(s, leg(), 15000)
  update(s, leg(20, 10, plan(2)), 20000)
  assert.equal(update(s, leg(20, 10, plan(2)), 32000).plan.summary, 'Main + sail 1')
})
test('reef increases and warnings bypass sail holding immediately', () => {
  const s = new LegGuidanceStabilizer()
  update(s, leg(), 0)
  const shown = update(s, leg(30, 20, plan(2, 'reef_1', ['Apparent wind speed exceeds sail limit.'])), 1000)
  assert.equal(shown.plan.mainsail_configuration, 'reef_1')
  assert.deepEqual(shown.guidanceStability.warnings, ['Apparent wind speed exceeds sail limit.'])
})
test('unsafe or unavailable held sails bypass the hold', () => {
  const s = new LegGuidanceStabilizer()
  update(s, leg(), 0)
  const raw = { ...leg(30, 20, plan(2)), candidateSails: [{ sail_id: 10 }, { sail_id: 1, warnings: ['Apparent wind speed exceeds sail limit.'] }, { sail_id: 2 }] }
  const shown = update(s, raw, 1000)
  assert.equal(shown.plan.summary, 'Main + sail 2')
  assert.match(shown.guidanceStability.warnings.join(' '), /exceeds/)
})
test('session, source, tack, stale gap and missing data reset display history', () => {
  for (const change of ['session', 'source', 'side', 'gap', 'clock']) {
    const s = new LegGuidanceStabilizer()
    update(s, leg(), 1000)
    const raw = leg(80, 30)
    if (change === 'source') raw.conditions.source = 'forecast'
    if (change === 'side') raw.windSide = 'starboard'
    const shown = update(s, raw, change === 'gap' ? 32001 : change === 'clock' ? 0 : 2000, change === 'session' ? 'another-race' : 'race')
    assert.equal(shown.awaDeg, 80)
  }
  const s = new LegGuidanceStabilizer()
  update(s, leg(), 0)
  assert.equal(update(s, leg(null, null), 1000).awaDeg, null)
  assert.equal(update(s, leg(80, 30), 2000).awaDeg, 80)
})
test('snake-case website legs use the same stability policy', () => {
  const s = new LegGuidanceStabilizer()
  const raw = { sequence: 1, awa_deg: 20, aws_knots: 10, recommended_sail_plan: plan(1) }
  s.update('web', [raw], 0)
  const shown = s.update('web', [{ ...raw, awa_deg: 40, aws_knots: 20 }], 15000)[0]
  assert.ok(shown.awa_deg > 32 && shown.awa_deg < 33)
})

test('warnings stay current while a nonurgent sail change is held', () => {
  const s = new LegGuidanceStabilizer()
  update(s, leg(), 0)
  const shown = update(s, leg(30, 20, plan(2, 'full_main', ['Estimated apparent gust exceeds sail limit.'])), 1000)
  assert.equal(shown.plan.summary, 'Main + sail 1')
  assert.equal(shown.guidanceStability.pendingSailChange, true)
  assert.match(shown.guidanceStability.warnings.join(' '), /exceeds/)
})
test('the first available recommendation is immediate', () => {
  const s = new LegGuidanceStabilizer()
  update(s, leg(20, 10, null), 0)
  assert.equal(update(s, leg(), 1000).plan.summary, 'Main + sail 1')
})
