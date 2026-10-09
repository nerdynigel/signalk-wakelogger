import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TrackArchive, archiveFileName, decodeTrackRecord, encodeTrackRecord } from '../../src/tracking/archive'
import { MAX_TRACK_POINTS, selectTrackIndexes, type TrackPoint } from '../../src/tracking/track'

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

async function tempDir(prefix = 'track-archive-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  directories.push(dir)
  return dir
}

async function tempArchive(options: ConstructorParameters<typeof TrackArchive>[1] = {}): Promise<{ archive: TrackArchive; dir: string }> {
  const dir = await tempDir()
  const archive = new TrackArchive(dir, options)
  await archive.open()
  return { archive, dir }
}

function point(sequence: number, capturedAt = 1_000_000 + sequence * 1000, latitude = -27 + (sequence % 1000) / 1000, longitude = 153): TrackPoint {
  return { sequence, capturedAt, latitude, longitude }
}

describe('track record codec', () => {
  it('round-trips a point without loss', () => {
    const original = point(42, 1_000_000, -27.123456789, 153.987654321)
    expect(decodeTrackRecord(encodeTrackRecord(original))).toEqual(original)
  })
})

describe('track decimation selection', () => {
  it('keeps every point when under the display bound and preserves the ends', () => {
    expect(selectTrackIndexes(3, 10)).toEqual([0, 1, 2])
    expect(selectTrackIndexes(0, 10)).toEqual([])
    const indexes = selectTrackIndexes(1000, 10)
    expect(indexes[0]).toBe(0)
    expect(indexes[indexes.length - 1]).toBe(999)
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)
  })
})

describe('durable recording archive', () => {
  it('returns sequence-ordered points and never depends on upload acknowledgement', async () => {
    const { archive } = await tempArchive()
    for (const sequence of [1, 2, 3, 4]) await archive.append('rec-a', point(sequence))
    const result = await archive.read('rec-a', { maxPoints: 100 })
    expect(result.points.map((p) => p.sequence)).toEqual([1, 2, 3, 4])
    expect(result.summary).toMatchObject({ fromSequence: 1, throughSequence: 4, totalSamples: 4, decimated: false })
  })

  it('decimates to the display cap while preserving the departure and latest point', async () => {
    const { archive } = await tempArchive()
    for (let sequence = 1; sequence <= 5000; sequence += 1) await archive.append('rec-big', point(sequence))
    const result = await archive.read('rec-big', { maxPoints: 2000 })
    expect(result.points).toHaveLength(2000)
    expect(result.points[0]!.sequence).toBe(1)
    expect(result.points[result.points.length - 1]!.sequence).toBe(5000)
    expect(result.summary.decimated).toBe(true)
  })

  it('scopes each recording to its own file so A and B never merge', async () => {
    const { archive, dir } = await tempArchive()
    await archive.append('rec-a', point(1, 1_000_000, -27, 153))
    await archive.append('rec-b', point(1, 1_000_000, -30, 155))
    await archive.append('rec-a', point(2, 1_001_000, -27.1, 153.1))
    expect((await archive.read('rec-a')).points.map((p) => p.latitude)).toEqual([-27, -27.1])
    expect((await archive.read('rec-b')).points.map((p) => p.latitude)).toEqual([-30])
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.wlt'))).toHaveLength(2)
  })

  it('applies sequence bounds and survives reopen', async () => {
    const { archive, dir } = await tempArchive()
    for (let sequence = 1; sequence <= 10; sequence += 1) await archive.append('rec-c', point(sequence))
    expect((await archive.read('rec-c', { maxPoints: 100, fromSequence: 4, throughSequence: 7 })).points.map((p) => p.sequence)).toEqual([4, 5, 6, 7])
    const reopened = new TrackArchive(dir)
    await reopened.open()
    expect((await reopened.read('rec-c', { maxPoints: 100 })).points).toHaveLength(10)
  })

  it('keeps the current and most-recent recording discoverable across reopen (independent of ACKed manifests)', async () => {
    const { archive, dir } = await tempArchive()
    await archive.append('rec-a', point(1, 5_000_000))
    await archive.markClosed('rec-a', 5_000_000)
    const reopened = new TrackArchive(dir)
    await reopened.open()
    expect(reopened.currentRecordingId()).toBe('rec-a')
    expect(reopened.recordingMeta('rec-a')).toMatchObject({ firstSequence: 1, lastSequence: 1, points: 1, closed: true, endedAt: 5_000_000 })
    expect((await reopened.read('rec-a')).points).toHaveLength(1)
  })

  it('rebuilds the manifest from files when it is lost', async () => {
    const { archive, dir } = await tempArchive()
    for (let sequence = 1; sequence <= 5; sequence += 1) await archive.append('rec-a', point(sequence))
    await archive.close()
    await fs.rm(path.join(dir, 'manifest.json'))
    const recovered = new TrackArchive(dir)
    await recovered.open()
    expect(recovered.currentRecordingId()).toBe('rec-a')
    expect(recovered.recordingMeta('rec-a')).toMatchObject({ firstSequence: 1, lastSequence: 5, points: 5 })
    expect((await recovered.read('rec-a')).points).toHaveLength(5)
  })

  it('is idempotent for duplicate/retried samples and ordered for concurrent appends', async () => {
    const { archive } = await tempArchive()
    await Promise.all([1, 2, 3, 4, 5].map((sequence) => archive.append('rec', point(sequence))))
    await archive.append('rec', point(3)) // retry of an existing sequence
    expect((await archive.read('rec', { maxPoints: 100 })).points.map((p) => p.sequence)).toEqual([1, 2, 3, 4, 5])
  })

  it('repairs a partial header and a partial final record before appending', async () => {
    const { archive, dir } = await tempArchive()
    await archive.append('rec', point(1))
    const target = path.join(dir, archiveFileName('rec'))
    // Simulate a crash mid-header on a fresh file.
    const fresh = path.join(dir, archiveFileName('rec-partial-header'))
    await fs.writeFile(fresh, Buffer.from([0x57, 0x4c, 0x54])) // 3 bytes
    await archive.append('rec-partial-header', point(1))
    expect((await archive.read('rec-partial-header')).points).toHaveLength(1)
    // Simulate a crash mid-record (trailing junk after a valid record).
    await fs.appendFile(target, Buffer.from([1, 2, 3, 4, 5, 6, 7]))
    await archive.append('rec', point(2))
    const result = await archive.read('rec', { maxPoints: 100 })
    expect(result.points.map((p) => p.sequence)).toEqual([1, 2])
  })

  it('quarantines a corrupt header and starts a fresh aligned file', async () => {
    const { archive, dir } = await tempArchive()
    const target = path.join(dir, archiveFileName('rec-corrupt'))
    await fs.writeFile(target, Buffer.alloc(64, 0x41)) // no WLT1 magic
    await archive.append('rec-corrupt', point(1))
    await archive.append('rec-corrupt', point(2))
    expect((await archive.read('rec-corrupt', { maxPoints: 100 })).points.map((p) => p.sequence)).toEqual([1, 2])
    const quarantined = (await fs.readdir(dir)).filter((name) => name.includes('.corrupt-'))
    expect(quarantined).toHaveLength(1)
  })

  it('bounds the pending-write backlog and reports the failure', async () => {
    const { archive } = await tempArchive({ maxPendingWrites: 2 })
    const first = archive.append('rec', point(1))
    const second = archive.append('rec', point(2))
    await expect(archive.append('rec', point(3))).rejects.toThrow('track_archive_backlog')
    await Promise.all([first, second])
    expect(archive.lastFailure()).toBe('track_archive_backlog')
    // Once drained, appends resume.
    await archive.append('rec', point(4))
    expect((await archive.read('rec', { maxPoints: 100 })).points.map((p) => p.sequence)).toEqual([1, 2, 4])
  })

  it('drains pending writes on close and resumes after an immediate restart', async () => {
    const dir = await tempDir()
    const first = new TrackArchive(dir)
    await first.open()
    await first.append('rec', point(1))
    await first.append('rec', point(2))
    await first.close()
    const restarted = new TrackArchive(dir)
    await restarted.open()
    expect((await restarted.read('rec', { maxPoints: 100 })).points.map((p) => p.sequence)).toEqual([1, 2])
    await restarted.append('rec', point(3))
    expect((await restarted.read('rec', { maxPoints: 100 })).points.map((p) => p.sequence)).toEqual([1, 2, 3])
  })

  it('prunes older recordings by capture age but never the active one', async () => {
    const now = 2_000_000_000_000
    const { archive, dir } = await tempArchive({ maxRecordings: 64, maxAgeMs: 60_000, now: () => now })
    await archive.append('old', point(1, now - 120_000))
    await archive.append('mid', point(1, now - 30_000))
    await archive.append('active', point(1, now - 1_000))
    await archive.markClosed('old', now - 120_000)
    await archive.prune('active')
    const names = (await fs.readdir(dir)).sort()
    expect(names).toContain(archiveFileName('active'))
    expect(names).toContain(archiveFileName('mid'))
    expect(names).not.toContain(archiveFileName('old'))
  })

  it('ignores an empty or corrupt file and rejects non-finite positions', async () => {
    const { archive, dir } = await tempArchive()
    await fs.writeFile(path.join(dir, archiveFileName('blank')), Buffer.alloc(0))
    await fs.writeFile(path.join(dir, archiveFileName('corrupt')), Buffer.from('not an archive at all'))
    expect((await archive.read('blank')).points).toEqual([])
    expect((await archive.read('corrupt')).points).toEqual([])
    await archive.append('rec', { sequence: 1, capturedAt: 1, latitude: Number.NaN, longitude: 1 })
    await archive.append('rec', { sequence: 2, capturedAt: 1, latitude: 1, longitude: 999 })
    expect((await archive.read('rec')).points).toEqual([])
  })

  it('handles a realistically large recording with work proportional to the display bound', async () => {
    const { archive } = await tempArchive()
    const total = 40_000
    for (let sequence = 1; sequence <= total; sequence += 1) await archive.append('long', point(sequence))
    const started = Date.now()
    const result = await archive.read('long', { maxPoints: MAX_TRACK_POINTS })
    expect(result.points).toHaveLength(MAX_TRACK_POINTS)
    expect(result.points[0]!.sequence).toBe(1)
    expect(result.points[result.points.length - 1]!.sequence).toBe(total)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
