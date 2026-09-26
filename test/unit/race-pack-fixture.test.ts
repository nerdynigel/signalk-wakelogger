import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRacePack } from '../../src/race/pack'

// Shared byte-for-byte with nerdynigel/wakelogger
// api/tests/fixtures/race_pack/race_pack_canonical.json.
export const CANONICAL_FIXTURE_SHA256 = 'd73627bc2106bb31dcde74a640f70a76e06d8d7d3a047c4a0573daaadfcba519'

describe('canonical race pack fixture', () => {
  it('parses the committed representative fixture', () => {
    const bytes = readFileSync(path.join(__dirname, '..', 'fixtures', 'race-pack.example.json'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(CANONICAL_FIXTURE_SHA256)
    const pack = parseRacePack(bytes)
    expect(pack.ruleSetVersion).toBe('race_plan_dynamic_v1')
    expect(pack.course.points.map((point) => point.kind)).toEqual(['start', 'mark', 'finish'])
    expect(pack.course.points[1]).toMatchObject({ rounding: 'starboard' })
    expect(pack.raceHeadsail).toMatchObject({ sail_id: 3, sail_name: 'No. 3 jib' })
    expect(pack.forecast.legs.map((leg) => leg.sequence)).toEqual([1, 2])
    expect(pack.forecast.legs[0]!.samples[0]).toMatchObject({ twd_deg: 45, tws_knots: 14 })
    expect(pack.forecast.coverage).toMatchObject({ from: '2026-09-17T02:00:00Z', until: '2026-09-17T04:00:00Z' })
    expect(pack.forecast.snapshot).toMatchObject({ provider: 'example-model' })
    expect(pack.polarSummary).toMatchObject({ eligible: false })
  })
})
