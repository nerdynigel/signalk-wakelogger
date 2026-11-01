import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { DatabaseOutbox } from '../../src/outbox/database-outbox'
import { SqlitePluginDatabase, betterSqlite3Available } from '../helpers/sqlite-plugin-database'

it.skipIf(!betterSqlite3Available)('persists idle exclusion accounting and protects aged trip rows on real SQLite', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'confirmed-sqlite-'))
  const target = path.join(directory, 'plugin.db')
  const handles: SqlitePluginDatabase[] = []
  let now = 1000
  const options = { protectRecordingHistory: true, maxBytes: 2000, maxAgeMs: 500, segmentBytes: 1024, now: () => now }
  const draft = { capturedAt: 1000, receivedAt: 1000, values: { lat: -27, lon: 153 }, quality: { timestamp: 'source' as const } }
  try {
    const database = new SqlitePluginDatabase(target); handles.push(database)
    const first = new DatabaseOutbox(database, 'device', options); await first.open()
    await first.append('device', draft)
    await first.append('device', { ...draft, trackingSessionId: 'confirmed-trip' })
    await first.acknowledge(1, 1)
    now = 1000000
    // Reopen committed state without calling the first outbox's close path.
    const reopenedDatabase = new SqlitePluginDatabase(target); handles.push(reopenedDatabase)
    const reopened = new DatabaseOutbox(reopenedDatabase, 'device', options); await reopened.open()
    expect(await reopened.stats()).toMatchObject({ acknowledgedSequence: 1, excludedCount: 1, droppedCount: 0, messageCount: 1 })
    let refused = false
    for (let index = 0; index < 20; index++) {
      const sequence = (await reopened.stats()).currentSequence
      try { await reopened.append('device', { ...draft, capturedAt: now + index, trackingSessionId: 'confirmed-trip' }) }
      catch {
        expect((await reopened.stats()).currentSequence).toBe(sequence)
        refused = true
        break
      }
    }
    expect(refused).toBe(true)
    expect((await reopened.pending(100, 100000))[0]?.sequence).toBe(2)
    expect((await reopened.stats()).droppedCount).toBe(0)
    await reopened.close()
  } finally {
    for (const database of handles.reverse()) database.close()
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
