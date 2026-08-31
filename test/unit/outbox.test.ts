import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileOutbox } from '../../src/outbox/file-outbox'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-outbox-'))
  directories.push(dir)
  return dir
}
function draft(capturedAt = 1000): any {
  return { capturedAt, receivedAt: capturedAt, values: { lat: -27, lon: 153 }, quality: { timestamp: 'source' } }
}
function options(overrides: object = {}): any {
  return { maxBytes: 1024 * 1024, maxAgeMs: 7 * 86_400_000, segmentBytes: 1024, now: () => 2000, ...overrides }
}

afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })

describe('FileOutbox', () => {
  it('persists sequence and acknowledgement state across restart', async () => {
    const dir = await tempDir()
    const first = new FileOutbox(dir, options())
    await first.open()
    expect((await first.append('dev_1', draft())).sequence).toBe(1)
    expect((await first.append('dev_1', draft())).sequence).toBe(2)
    await first.acknowledge(1)
    await first.close()

    const recovered = new FileOutbox(dir, options())
    await recovered.open()
    expect((await recovered.pending(10, 10_000)).map((sample) => sample.sequence)).toEqual([2])
    expect((await recovered.append('dev_1', draft())).sequence).toBe(3)
  })

  it('truncates a partially written tail and recovers the last complete record', async () => {
    const dir = await tempDir()
    const outbox = new FileOutbox(dir, options())
    await outbox.open()
    await outbox.append('dev_1', draft())
    await outbox.close()
    const segment = (await fs.readdir(dir)).find((name) => name.endsWith('.log')) as string
    await fs.appendFile(path.join(dir, segment), Buffer.from([0, 0, 0, 50, 1, 2, 3]))

    const recovered = new FileOutbox(dir, options())
    await recovered.open()
    expect((await recovered.pending(10, 10_000)).map((sample) => sample.sequence)).toEqual([1])
    expect((await recovered.append('dev_1', draft())).sequence).toBe(2)
  })

  it('rotates segments and accounts for dropped old records when bounded', async () => {
    const dir = await tempDir()
    const outbox = new FileOutbox(dir, options({ segmentBytes: 250, maxAgeMs: 500 }))
    await outbox.open()
    await outbox.append('dev_1', draft(1000))
    await outbox.append('dev_1', draft(1100))
    await outbox.append('dev_1', draft(2000))
    const stats = await outbox.stats()
    expect(stats.droppedCount).toBeGreaterThan(0)
    expect(stats.droppedThrough).toBeGreaterThan(0)
    expect(stats.messageCount).toBeGreaterThanOrEqual(1)
  })

  it('preserves an accelerated 24-hour outage across restart and drains only through application ACK', async () => {
    const dir = await tempDir()
    let now = 0
    const outageOptions = options({
      segmentBytes: 2048,
      maxAgeMs: 7 * 86_400_000,
      now: () => now
    })
    const first = new FileOutbox(dir, outageOptions)
    await first.open()
    for (let hour = 0; hour < 24; hour += 1) {
      now = hour * 3_600_000
      await first.append('dev_1', draft(now))
    }
    await first.close()

    now = 24 * 3_600_000
    const recovered = new FileOutbox(dir, outageOptions)
    await recovered.open()
    expect((await recovered.pending(30, 1_000_000)).map((item) => item.sequence)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1)
    )
    expect((await recovered.append('dev_1', draft(now))).sequence).toBe(25)
    await recovered.acknowledge(12)
    await recovered.close()

    const afterAckRestart = new FileOutbox(dir, outageOptions)
    await afterAckRestart.open()
    expect((await afterAckRestart.pending(30, 1_000_000)).map((item) => item.sequence)).toEqual(
      Array.from({ length: 13 }, (_, index) => index + 13)
    )
    expect(await afterAckRestart.stats()).toMatchObject({
      acknowledgedSequence: 12,
      currentSequence: 25,
      droppedCount: 0
    })
  })
})
