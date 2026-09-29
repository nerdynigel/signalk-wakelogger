// Crash / abrupt-shutdown recovery evidence.
//
// SCOPE AND HONESTY NOTE
// - These are storage-level and store-level simulations: committed writes are
//   produced by real implementations (FileOutbox on the real filesystem,
//   DatabaseOutbox on a real file-backed SQLite engine), then the in-process
//   instance is dropped WITHOUT the graceful close() path and a fresh instance
//   must recover. That proves the durability boundary, not that every sample is
//   power-loss durable.
// - A genuine OS process kill (SIGKILL of the Signal K container, ungraceful)
//   is exercised separately by `scripts/test-signalk-docker.mjs`
//   (`npm run test:docker`), which is the process-kill evidence for the file
//   backend. No vitest test here spawns or kills an OS process.
// - Storage/power-loss simulation is labelled per test.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseOutbox } from '../../src/outbox/database-outbox'
import { FileOutbox } from '../../src/outbox/file-outbox'
import type { PluginDatabase } from '../../src/outbox/database-types'
import { TrackArchive } from '../../src/tracking/archive'
import { SqlitePluginDatabase } from '../helpers/sqlite-plugin-database'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function tempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

function draft(capturedAt = 1000): any {
  return { capturedAt, receivedAt: capturedAt, values: { lat: -27, lon: 153 }, quality: { timestamp: 'source' } }
}

function options(overrides: object = {}): any {
  return { maxBytes: 1_000_000, maxAgeMs: 7 * 86_400_000, segmentBytes: 65_536, now: () => 2_000, ...overrides }
}

describe('abrupt shutdown recovery', () => {
  it('reopens a real SQLite-backed DatabaseOutbox after losing the instance and keeps committed state', async () => {
    const directory = await tempDir('crash-db-')
    const file = path.join(directory, 'plugin.db')
    const database = new SqlitePluginDatabase(file)
    cleanups.push(() => database.close())
    const outbox = new DatabaseOutbox(database, 'dev_1', options())
    await outbox.open()
    expect((await outbox.append('dev_1', draft())).sequence).toBe(1)
    expect((await outbox.append('dev_1', draft())).sequence).toBe(2)
    await outbox.acknowledge(1)
    // Record the real durability boundary this backend provides.
    expect(database.durability()).toMatchObject({ journalMode: 'wal', synchronous: 2 })

    // "Crash": abandon the instance without close(), then reopen on a fresh connection.
    const recovered = new DatabaseOutbox(new SqlitePluginDatabase(file), 'dev_1', options())
    await recovered.open()
    expect((await recovered.pending(10, 100_000)).map((sample) => sample.sequence)).toEqual([2])
    expect((await recovered.append('dev_1', draft())).sequence).toBe(3)
    expect(await recovered.stats()).toMatchObject({ acknowledgedSequence: 1, currentSequence: 3 })
  })

  it('does not treat a rolled-back sequence allocation as loss, and does not reuse the sequence', async () => {
    const directory = await tempDir('crash-db-')
    const database = new SqlitePluginDatabase(path.join(directory, 'plugin.db'))
    cleanups.push(() => database.close())
    await new DatabaseOutbox(database, 'dev_1', options()).open()

    // Power-loss simulation: an append that wrote the record and advanced the
    // allocator but died before COMMIT. The transaction rolls back on reopen.
    await database
      .transaction(async (tx: PluginDatabase) => {
        await tx.run(
          'INSERT INTO outbox_records (device_id, sequence, captured_at, received_at, payload, payload_bytes) VALUES (?, ?, ?, ?, ?, ?)',
          ['dev_1', 1, 1000, 1000, '{"sequence":1}', 14]
        )
        await tx.run('UPDATE outbox_state SET next_sequence = ? WHERE device_id = ?', [2, 'dev_1'])
        throw new Error('power-loss-before-commit')
      })
      .catch(() => undefined)

    const recovered = new DatabaseOutbox(database, 'dev_1', options())
    await recovered.open()
    // The uncommitted allocation was neither persisted nor declared lost, and the
    // next real append reuses sequence 1 rather than leaking a phantom gap.
    expect((await recovered.append('dev_1', draft())).sequence).toBe(1)
    expect(await recovered.stats()).toMatchObject({ currentSequence: 1, droppedCount: 0, droppedThrough: 0 })
  })

  it('FileOutbox persists an acknowledgement before reclaiming, so a crash mid-reclaim never resends delivered samples', async () => {
    const directory = await tempDir('crash-file-')
    const outbox = new FileOutbox(directory, options())
    await outbox.open()
    for (let sequence = 1; sequence <= 4; sequence += 1) await outbox.append('dev_1', draft(sequence))
    await outbox.close()

    // Storage simulation: the ACK was fsynced to metadata.json but the process
    // died before the acknowledged segments were unlinked.
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'metadata.json'), 'utf8'))
    metadata.acknowledgedSequence = 3
    await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata))

    const recovered = new FileOutbox(directory, options())
    await recovered.open()
    expect((await recovered.pendingAfter(0, 10, 100_000)).map((sample) => sample.sequence)).toEqual([4])
    expect(await recovered.stats()).toMatchObject({ acknowledgedSequence: 3, currentSequence: 4 })
    await recovered.acknowledge(4)
    expect(await recovered.pendingAfter(0, 10, 100_000)).toEqual([])
    await recovered.close()
  })

  it('persists a loss declaration across an abrupt reopen for both backends', async () => {
    const fileDirectory = await tempDir('crash-loss-file-')
    // Segment must exceed one record's payload (else the reader rejects it) but
    // be below two, so each append rotates to its own segment.
    const fileOptions = options({ maxBytes: 1, segmentBytes: 200 })
    const file = new FileOutbox(fileDirectory, fileOptions)
    await file.open()
    for (let sequence = 1; sequence <= 3; sequence += 1) await file.append('dev_1', draft(sequence))
    const fileDrops = await file.stats()
    expect(fileDrops.droppedThrough).toBeGreaterThan(0)
    await file.close()
    const reopenedFile = new FileOutbox(fileDirectory, fileOptions)
    await reopenedFile.open()
    expect(await reopenedFile.stats()).toMatchObject({
      droppedCount: fileDrops.droppedCount,
      droppedThrough: fileDrops.droppedThrough
    })
    await reopenedFile.close()

    const dbDirectory = await tempDir('crash-loss-db-')
    const database = new SqlitePluginDatabase(path.join(dbDirectory, 'plugin.db'))
    cleanups.push(() => database.close())
    const dbOutbox = new DatabaseOutbox(database, 'dev_1', options({ maxBytes: 1 }))
    await dbOutbox.open()
    for (let sequence = 1; sequence <= 3; sequence += 1) await dbOutbox.append('dev_1', draft(sequence))
    const dbDrops = await dbOutbox.stats()
    expect(dbDrops.droppedThrough).toBeGreaterThan(0)
    const reopenedDb = new DatabaseOutbox(database, 'dev_1', options({ maxBytes: 1 }))
    await reopenedDb.open()
    expect(await reopenedDb.stats()).toMatchObject({
      droppedCount: dbDrops.droppedCount,
      droppedThrough: dbDrops.droppedThrough
    })
  })

  it('ignores a leftover manifest.json.tmp from an interrupted write and keeps committed archive data', async () => {
    const directory = await tempDir('crash-archive-')
    const archive = new TrackArchive(directory)
    await archive.open()
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await archive.append('rec-1', { sequence, capturedAt: 1000 + sequence, latitude: -27, longitude: 153 })
    }
    await archive.close()

    // Storage simulation: crash after writing manifest.json.tmp but before rename.
    await fs.writeFile(path.join(directory, 'manifest.json.tmp'), '{ this is a torn write')

    const recovered = new TrackArchive(directory)
    await recovered.open()
    expect(recovered.recordingMeta('rec-1')).toMatchObject({ firstSequence: 1, lastSequence: 3, points: 3 })
    expect((await recovered.read('rec-1', { maxPoints: 100 })).points.map((point) => point.sequence)).toEqual([1, 2, 3])
    await recovered.close()
  })

  it('rebuilds a torn archive manifest from committed files without inventing travel', async () => {
    const directory = await tempDir('crash-archive-')
    const archive = new TrackArchive(directory)
    await archive.open()
    await archive.append('rec-1', { sequence: 1, capturedAt: 5_000_000, latitude: -27, longitude: 153 })
    await archive.append('rec-1', { sequence: 2, capturedAt: 5_001_000, latitude: -27.01, longitude: 153.01 })
    await archive.close()

    // Storage simulation: the atomic rename never completed, leaving a torn manifest.
    await fs.writeFile(path.join(directory, 'manifest.json'), '{"version":1,"recordings":[{"id":"rec-1"')

    const recovered = new TrackArchive(directory)
    await recovered.open()
    expect(recovered.recordingMeta('rec-1')).toMatchObject({ firstSequence: 1, lastSequence: 2, points: 2 })
    expect((await recovered.read('rec-1', { maxPoints: 100 })).points.map((point) => point.sequence)).toEqual([1, 2])
    await recovered.close()
  })
})
