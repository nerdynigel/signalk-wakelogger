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
// - Teardown is intentionally separate from the simulated crash: every SQLite
//   handle (including reopened ones) is registered and closed, then directories
//   are removed with retries, so Windows EBUSY from a live handle cannot leak.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseOutbox } from '../../src/outbox/database-outbox'
import { FileOutbox } from '../../src/outbox/file-outbox'
import type { PluginDatabase } from '../../src/outbox/database-types'
import { TrackArchive } from '../../src/tracking/archive'
import {
  SqlitePluginDatabase,
  betterSqlite3Available,
  betterSqlite3LoadError
} from '../helpers/sqlite-plugin-database'

const pendingCleanups: Array<() => Promise<void> | void> = []
function onCleanup(action: () => Promise<void> | void): void {
  pendingCleanups.push(action)
}

async function removeDirectory(directory: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}

afterEach(async () => {
  // Attempt every cleanup action (handles first, then directories) and report
  // any genuine failure rather than aborting on the first one.
  const failures: unknown[] = []
  for (const cleanup of pendingCleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'crash-recovery cleanup failed')
})

async function tempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  onCleanup(() => removeDirectory(directory))
  return directory
}

function openDatabase(directory: string, file = 'plugin.db'): SqlitePluginDatabase {
  const database = new SqlitePluginDatabase(path.join(directory, file))
  onCleanup(() => database.close())
  return database
}

function draft(capturedAt = 1000): any {
  return { capturedAt, receivedAt: capturedAt, values: { lat: -27, lon: 153 }, quality: { timestamp: 'source' } }
}

function options(overrides: object = {}): any {
  return { maxBytes: 1_000_000, maxAgeMs: 7 * 86_400_000, segmentBytes: 65_536, now: () => 2_000, ...overrides }
}

// The SQLite half of these simulations needs the better-sqlite3 native binding.
// Environments that install with --ignore-scripts (e.g. the Signal K plugin
// registry harness) have no binding, so skip there; CI builds it first via
// `npm run prepare:test-sqlite` and runs the full suite.
if (!betterSqlite3Available) {
  console.warn(
    `[crash-recovery] skipping SQLite durability suite: better-sqlite3 binding unavailable ` +
      `(${betterSqlite3LoadError() instanceof Error ? (betterSqlite3LoadError() as Error).message : String(betterSqlite3LoadError())}). ` +
      'Run `npm run prepare:test-sqlite` to enable it.'
  )
}

describe.skipIf(!betterSqlite3Available)('abrupt shutdown recovery', () => {
  it('reopens a real SQLite-backed DatabaseOutbox after losing the instance and keeps committed state', async () => {
    const directory = await tempDir('crash-db-')
    const database = openDatabase(directory)
    const outbox = new DatabaseOutbox(database, 'dev_1', options())
    await outbox.open()
    expect((await outbox.append('dev_1', draft())).sequence).toBe(1)
    expect((await outbox.append('dev_1', draft())).sequence).toBe(2)
    await outbox.acknowledge(1)
    // Record the real durability boundary this backend provides.
    expect(database.durability()).toMatchObject({ journalMode: 'wal', synchronous: 2 })

    // "Crash": abandon the instance without close(), then reopen a fresh connection.
    const recovered = new DatabaseOutbox(openDatabase(directory), 'dev_1', options())
    await recovered.open()
    expect((await recovered.pending(10, 100_000)).map((sample) => sample.sequence)).toEqual([2])
    expect((await recovered.append('dev_1', draft())).sequence).toBe(3)
    expect(await recovered.stats()).toMatchObject({ acknowledgedSequence: 1, currentSequence: 3 })
  })

  it('does not declare a rolled-back allocation lost, and never reassigns a committed sequence', async () => {
    const directory = await tempDir('crash-db-')
    const database = openDatabase(directory)
    await new DatabaseOutbox(database, 'dev_1', options()).open()

    // Power-loss simulation: an append that wrote the record and advanced the
    // allocator but died before COMMIT. The transaction rolls back.
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
    // A fully rolled-back allocation was never committed or emitted, so it may
    // legitimately be reused for the next sample, and it is not declared lost.
    expect((await recovered.append('dev_1', draft())).sequence).toBe(1)
    expect(await recovered.stats()).toMatchObject({ currentSequence: 1, droppedCount: 0, droppedThrough: 0 })
    // Once committed, the sequence identity is fixed: the next sample gets a new
    // sequence and never reuses the committed one for a different sample.
    expect((await recovered.append('dev_1', draft())).sequence).toBe(2)
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
    const database = openDatabase(dbDirectory)
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
