import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProgressionDetection } from '../../src/race/detection'
import { RaceProgressionStore } from '../../src/race/progression-store'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'race-progression-store-'))
  directories.push(directory)
  const store = new RaceProgressionStore(path.join(directory, 'race', 'state.json'))
  await store.open()
  return { directory, store }
}

const detection: ProgressionDetection = {
  type: 'rounding', pointIndex: 2, at: 1000, confidence: 'high', passedSide: 'starboard', wrongSide: false, distanceM: 24.5, sogKn: 5, revision: 3
}

describe('race progression store', () => {
  it('appends events with monotonic sequences and tracks publication', async () => {
    const f = await fixture()
    const first = await f.store.append('detected', 'auto', detection, 1000)
    const second = await f.store.append('auto_applied', 'auto', detection, 1001)
    expect(second).toBe(first + 1)
    expect(f.store.pending().map((event) => event.sequence)).toEqual([first, second])
    expect(f.store.latest()?.action).toBe('auto_applied')

    await f.store.markPublished([first])
    expect(f.store.pending().map((event) => event.sequence)).toEqual([second])
  })

  it('persists the mode and events across reopen', async () => {
    const f = await fixture()
    await f.store.append('observed', 'off', detection, 1000)
    await f.store.setMode('suggest')
    await f.store.close()

    const reopened = new RaceProgressionStore(path.join(f.directory, 'race', 'state.json'))
    await reopened.open()
    expect(reopened.mode()).toBe('suggest')
    expect(reopened.latest()?.detection.pointIndex).toBe(2)
    expect(reopened.pending()).toHaveLength(1)
  })

  it('starts empty when the checkpoint is missing and rejects invalid checkpoints', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'race-progression-store-'))
    directories.push(directory)
    const missing = new RaceProgressionStore(path.join(directory, 'state.json'))
    await missing.open()
    expect(missing.mode()).toBeUndefined()

    const target = path.join(directory, 'invalid.json')
    await fs.writeFile(target, JSON.stringify({ version: 2 }))
    const invalid = new RaceProgressionStore(target)
    await expect(invalid.open()).rejects.toThrow('race_progression_checkpoint_invalid')
  })
})