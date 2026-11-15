// Opt-in repeatable local storage measurement; no broker/server/hardware claims.
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { FileOutbox } from '../../src/outbox/file-outbox'
import { DatabaseOutbox } from '../../src/outbox/database-outbox'
import { SqlitePluginDatabase, betterSqlite3Available } from '../helpers/sqlite-plugin-database'
import type { TelemetryDraft } from '../../src/telemetry/types'

describe.skipIf(process.env.MEASURE_UPLOAD !== '1')('6100 sample local storage backlog measurement', () => {
  it.each(['file', 'database'])('measures %s selection, statistics and durable ACK without emitting payloads', async backend => {
    if (backend === 'database' && !betterSqlite3Available) return
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-backlog-'))
    const options = { maxBytes: 100_000_000, maxAgeMs: 86400_000, segmentBytes: 4 * 1024 * 1024, now: () => 10_000_000, protectRecordingHistory: true }
    const database = backend === 'database' ? new SqlitePluginDatabase(path.join(directory, 'outbox.sqlite')) : null
    const outbox = database ? new DatabaseOutbox(database, 'synthetic', options) : new FileOutbox(directory, options)
    const draft: TelemetryDraft = { capturedAt: 1_000_000, receivedAt: 1_000_000, trackingSessionId: 'synthetic-race', values: { lat: -27, lon: 153, sog_kn: 6, cog_deg: 90, aws_kn: 15, awa_deg: 40 }, quality: { timestamp: 'source' }, guidance: { legs: Array.from({ length: 7 }, (_, i) => ({ sequence: i + 1, bearing: 80 + i * 15, distance: 2.5, awa: 35 + i * 5, aws: 15, twd: 100, tws: 12, recommendedSail: 'Synthetic jib', sailPlan: { main: 'Full main', headsail: 'Synthetic jib' }, targetSpeed: 6.5, eta: '2026-11-15T04:00:00Z' })) } } as unknown as TelemetryDraft
    try {
      // Preseed valid checksummed file frames to exclude capture/fsync setup from
      // the drain measurement. open() verifies every frame with real code.
      if (!database) {
        let records: Buffer[] = []; let bytes = 0; let first = 1
        for (let sequence = 1; sequence <= 6100; sequence++) {
          const payload = Buffer.from(JSON.stringify({ v: 1, deviceId: 'synthetic', sequence, ...draft }))
          const header = Buffer.alloc(4); header.writeUInt32BE(payload.length)
          const record = Buffer.concat([header, payload, createHash('sha256').update(payload).digest()])
          if (bytes + record.length > options.segmentBytes && records.length) { await fs.writeFile(path.join(directory, `segment-${String(first).padStart(12, '0')}.log`), Buffer.concat(records)); records = []; bytes = 0; first = sequence }
          records.push(record); bytes += record.length
        }
        await fs.writeFile(path.join(directory, `segment-${String(first).padStart(12, '0')}.log`), Buffer.concat(records))
      }
      await outbox.open()
      if (database) for (let i = 0; i < 6100; i++) await outbox.append('synthetic', draft)
      const timings = { selectMs: 0, statsMs: 0, persistMs: 0, bytes: 0, batches: 0, minBatch: 1000, maxBatch: 0 }
      let cursor = 0; const started = performance.now()
      while (cursor < 6100) {
        let at = performance.now(); const samples = await outbox.pendingAfter(cursor, 60, 64512); timings.selectMs += performance.now() - at
        expect(samples.length).toBeGreaterThan(0)
        at = performance.now(); await outbox.stats(); timings.statsMs += performance.now() - at
        cursor = samples.at(-1)!.sequence
        timings.bytes += Buffer.byteLength(JSON.stringify({ v: 1, deviceId: 'synthetic', samples })); timings.batches++
        timings.minBatch = Math.min(timings.minBatch, samples.length); timings.maxBatch = Math.max(timings.maxBatch, samples.length)
        at = performance.now(); await outbox.acknowledge(cursor); timings.persistMs += performance.now() - at
      }
      const elapsedMs = performance.now() - started
      expect(await outbox.stats()).toMatchObject({ acknowledgedSequence: 6100, messageCount: 0 })
      console.log(JSON.stringify({ backend, uniqueSamples: cursor, elapsedMs, uniqueSamplesPerSecond: 6100 / (elapsedMs / 1000), retransmissionRatio: 0, ...timings }))
    } finally { await outbox.close(); database?.close(); await fs.rm(directory, { recursive: true, force: true }) }
  }, 180_000)
})
