import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CourseProgressPoint, ProgressFix } from '../../src/race/detection'
import { RaceProgressionService } from '../../src/race/progression-service'
import { RaceProgressionStore } from '../../src/race/progression-store'

const START = { latitude: -27.45, longitude: 153.05 }
const MARK = offset(START, 500, 0)
const FINISH = offset(MARK, 0, 500)

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })

function offset(origin: { latitude: number; longitude: number }, northM: number, eastM: number) {
  return {
    latitude: origin.latitude + northM / 111_320,
    longitude: origin.longitude + eastM / (111_320 * Math.cos(origin.latitude * Math.PI / 180))
  }
}

function course(): CourseProgressPoint[] {
  return [
    { ...START, kind: 'start' },
    { ...MARK, kind: 'mark', rounding: 'starboard' },
    { ...FINISH, kind: 'finish' }
  ]
}

function track(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }, steps: number): ProgressFix[] {
  const fixes: ProgressFix[] = []
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps
    fixes.push({
      at: 1_000_000 + index * 1000,
      latitude: from.latitude + (to.latitude - from.latitude) * ratio,
      longitude: from.longitude + (to.longitude - from.longitude) * ratio,
      sogKn: 4
    })
  }
  return fixes
}

async function fixture(mode: 'auto' | 'suggest' | 'off' = 'auto') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'race-progression-service-'))
  directories.push(directory)
  const store = new RaceProgressionStore(path.join(directory, 'race', 'state.json'))
  await store.open()
  const service = new RaceProgressionService({ store, defaultMode: mode, config: { minSogKn: 1, captureRadiusM: 75, maxAccuracyM: 25 }, now: () => 2_000_000 })
  service.updateCourse({ revision: 7, points: course(), reverse: false, activeIndex: 1, matches: true })
  return { store, service, directory }
}

function roundingTrack(offsetEastM = -20) {
  return track(offset(MARK, -200, offsetEastM), offset(MARK, 200, offsetEastM), 40)
}

describe('race progression service', () => {
  it('detects in auto mode, records evidence and advances on resolve', async () => {
    const f = await fixture('auto')
    let detection = null
    for (const fix of roundingTrack()) detection = f.service.fix(fix) ?? detection
    expect(detection).toMatchObject({ pointIndex: 1, wrongSide: false })
    await f.store.close()
    expect(f.store.latest()?.action).toBe('detected')
    expect(f.store.pending()).toHaveLength(1)

    expect(await f.service.resolve('accepted', 1)).toBe(true)
    await f.store.close()
    expect(f.store.latest()?.action).toBe('auto_applied')
    expect(f.service.status()).toMatchObject({ mode: 'auto', activeIndex: 2, pending: null })
  })

  it('holds suggest detections until resolved and ignores mismatched points', async () => {
    const f = await fixture('suggest')
    for (const fix of roundingTrack()) f.service.fix(fix)
    await f.store.close()
    expect(f.store.latest()?.action).toBe('detected')
    expect(await f.service.resolve('accepted', 2)).toBe(false)
    expect(await f.service.resolve('dismissed', 1)).toBe(true)
    await f.store.close()
    expect(f.store.latest()?.action).toBe('dismissed')
    expect(f.service.status()).toMatchObject({ activeIndex: 1, pending: null })
  })

  it('records wrong-side passes without queuing an advance', async () => {
    const f = await fixture('auto')
    for (const fix of roundingTrack(35)) f.service.fix(fix)
    await f.store.close()
    expect(f.store.latest()).toMatchObject({ action: 'wrong_side' })
    expect(f.service.status()).toMatchObject({ pending: null, activeIndex: 1 })
  })

  it('records observed detections in off mode without pending state', async () => {
    const f = await fixture('off')
    for (const fix of roundingTrack()) f.service.fix(fix)
    await f.store.close()
    expect(f.store.latest()).toMatchObject({ action: 'observed' })
    expect(f.service.status()).toMatchObject({ pending: null })
  })

  it('ignores fixes while the native route does not match the desired course', async () => {
    const f = await fixture('auto')
    f.service.updateCourse({ revision: 7, points: course(), reverse: false, activeIndex: 1, matches: false })
    for (const fix of roundingTrack()) expect(f.service.fix(fix)).toBeNull()
    await f.store.close()
    expect(f.store.latest()).toBeUndefined()
  })

  it('clears pending state when the active index changes externally', async () => {
    const f = await fixture('auto')
    for (const fix of roundingTrack()) f.service.fix(fix)
    expect(f.service.status()).toMatchObject({ pending: { pointIndex: 1 } })
    f.service.updateCourse({ revision: 7, points: course(), reverse: false, activeIndex: 2, matches: true })
    expect(f.service.status()).toMatchObject({ pending: null, activeIndex: 2 })
  })

  it('persists a mode change and exposes it after reopen', async () => {
    const f = await fixture('auto')
    expect(f.service.mode).toBe('auto')
    await f.service.setMode('suggest')
    expect(f.service.mode).toBe('suggest')
    f.service.updateCourse(null)
    await f.store.close()

    const reopened = new RaceProgressionStore(path.join(f.directory, 'race', 'state.json'))
    await reopened.open()
    const service = new RaceProgressionService({ store: reopened, defaultMode: 'auto' })
    expect(service.mode).toBe('suggest')
  })
})