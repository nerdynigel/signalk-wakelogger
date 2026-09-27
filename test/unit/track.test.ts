import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TrackArchive, archiveFileName, decodeTrackRecord, encodeTrackRecord } from '../../src/tracking/archive'
import { MAX_TRACK_POINTS, selectTrackIndexes, type TrackPoint } from '../../src/tracking/track'

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })

async function tempArchive(options: ConstructorParameters<typeof TrackArchive>[1] = {}): Promise<{ archive: TrackArchive; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'track-archive-'))
  directories.push(dir)
  const archive = new TrackArchive(dir, options)
  await archive.open()
  return { archive, dir }
}

function point(sequence: number, latitude = -27 + (sequence % 1000) / 1000, longitude = 153): TrackPoint {
  return { sequence, capturedAt: 1_000_000 + sequence * 1000, latitude, longitude }
}

describe('track record codec', () => {
  it('round-trips a point without loss', () => {
    const original = point(42, -27.123456789, 153.987654321)
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
    expect(indexes).toHaveLength(10)
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
    expect(result.storageBackend).toBe('archive')
  })

  it('decimates to the display cap while preserving the departure and latest point', async () => {
    const { archive } = await tempArchive()
    for (let sequence = 1; sequence <= 5000; sequence += 1) await archive.append('rec-big', point(sequence))
    const result = await archive.read('rec-big', { maxPoints: 2000 })
    expect(result.points).toHaveLength(2000)
    expect(result.points[0]!.sequence).toBe(1)
    expect(result.points[result.points.length - 1]!.sequence).toBe(5000)
    expect(result.summary.decimated).toBe(true)
    expect(result.summary.totalSamples).toBe(5000)
  })

  it('scopes each recording to its own file so A and B never merge', async () => {
    const { archive, dir } = await tempArchive()
    await archive.append('rec-a', point(1, -27, 153))
    await archive.append('rec-b', point(1, -30, 155))
    await archive.append('rec-a', point(2, -27.1, 153.1))
    const a = await archive.read('rec-a')
    const b = await archive.read('rec-b')
    expect(a.points.map((p) => p.latitude)).toEqual([-27, -27.1])
    expect(b.points.map((p) => p.latitude)).toEqual([-30])
    expect(archiveFileName('rec-a')).not.toBe(archiveFileName('rec-b'))
    expect((await fs.readdir(dir)).length).toBe(2)
  })

  it('applies sequence bounds and survives reopen', async () => {
    const { archive, dir } = await tempArchive()
    for (let sequence = 1; sequence <= 10; sequence += 1) await archive.append('rec-c', point(sequence))
    const bounded = await archive.read('rec-c', { maxPoints: 100, fromSequence: 4, throughSequence: 7 })
    expect(bounded.points.map((p) => p.sequence)).toEqual([4, 5, 6, 7])
    const reopened = new TrackArchive(dir)
    await reopened.open()
    expect((await reopened.read('rec-c', { maxPoints: 100 })).points).toHaveLength(10)
  })

  it('prunes older recordings under retention pressure but never the active one', async () => {
    const now = 1_000_000_000_000
    const { archive, dir } = await tempArchive({ maxRecordings: 2, maxAgeMs: 60_000, now: () => now })
    await archive.append('old', point(1))
    await fs.utimes(path.join(dir, archiveFileName('old')), (now - 120_000) / 1000, (now - 120_000) / 1000)
    await archive.append('mid', point(1))
    await archive.append('active', point(1))
    await archive.prune('active')
    const names = (await fs.readdir(dir)).sort()
    expect(names).toContain(archiveFileName('active'))
    // 'old' is both age-expired and beyond the count; 'mid' survives.
    expect(names).not.toContain(archiveFileName('old'))
    expect((await archive.read('mid')).points).toHaveLength(1)
  })

  it('ignores an empty or corrupt file instead of failing the request', async () => {
    const { archive, dir } = await tempArchive()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, archiveFileName('blank')), Buffer.alloc(0))
    await fs.writeFile(path.join(dir, archiveFileName('corrupt')), Buffer.from('not an archive at all'))
    expect((await archive.read('blank')).points).toEqual([])
    expect((await archive.read('corrupt')).points).toEqual([])
    expect((await archive.read('missing')).points).toEqual([])
  })

  it('rejects non-finite positions without writing a record', async () => {
    const { archive } = await tempArchive()
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
    const elapsed = Date.now() - started
    expect(result.points).toHaveLength(MAX_TRACK_POINTS)
    expect(result.points[0]!.sequence).toBe(1)
    expect(result.points[result.points.length - 1]!.sequence).toBe(total)
    // Seeking fixed-size records must not scale with the full recording length.
    expect(elapsed).toBeLessThan(2000)
  })
})
