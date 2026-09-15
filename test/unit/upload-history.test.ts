import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { UploadHistory } from '../../src/tracking/history'
import type { OutboxStats } from '../../src/outbox/interface'
const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
const stats = (overrides: Partial<OutboxStats> = {}): OutboxStats => ({ storageBackend: 'file', messageCount: 10, diskBytes: 1000, acknowledgedSequence: 10, currentSequence: 20, droppedCount: 0, droppedThrough: 0, ...overrides })
it('persists a fixed historical cohort across restart and excludes later live samples', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-history-')); directories.push(dir)
  const target = path.join(dir, 'state.json')
  const history = new UploadHistory(target); await history.open(); await history.update(stats(), true)
  const id = history.current()!.id
  await history.update(stats({ acknowledgedSequence: 15, currentSequence: 25 }))
  expect(history.current()).toMatchObject({ id, throughSequence: 20, totalSamples: 10, remainingSamples: 5, uploadedSamples: 5 })
  const resumed = new UploadHistory(target); await resumed.open()
  await resumed.update(stats({ acknowledgedSequence: 17, currentSequence: 27 }), true)
  expect(resumed.current()).toMatchObject({ id, totalSamples: 10, remainingSamples: 3, uploadedSamples: 7 })
  await resumed.update(stats({ acknowledgedSequence: 23, currentSequence: 28 }))
  expect(resumed.current()).toMatchObject({ id, remainingSamples: 0, uploadedSamples: 10, completedAt: expect.any(Number) })
  await resumed.update(stats({ acknowledgedSequence: 24, currentSequence: 30 }))
  expect(resumed.current()!.id).toBe(id)
})
it('never labels observed retention losses as uploads and marks ambiguous attribution unknown', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-loss-')); directories.push(dir)
  const history = new UploadHistory(path.join(dir, 'state.json')); await history.open(); await history.update(stats(), true)
  await history.update(stats({ droppedThrough: 15, droppedCount: 5 }))
  expect(history.current()).toMatchObject({ remainingSamples: 5, uploadedSamples: 0, droppedSamples: 5, progressKnown: false })
  await history.update(stats({ acknowledgedSequence: 20, droppedThrough: 15, droppedCount: 5 }))
  expect(history.current()).toMatchObject({ remainingSamples: 0, uploadedSamples: 5, droppedSamples: 5, progressKnown: false })
})
