import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseOutbox } from '../../src/outbox/database-outbox'
import type { PluginDatabase } from '../../src/outbox/database-types'
import { FileOutbox } from '../../src/outbox/file-outbox'

interface State { next_sequence: number; acknowledged_sequence: number; dropped_count: number; dropped_through: number }
interface RecordRow { device_id: string; sequence: number; captured_at: number; received_at: number; payload: string; payload_bytes: number }

class MemoryDatabase implements PluginDatabase {
  state = new Map<string, State>()
  records: RecordRow[] = []
  async migrate(): Promise<void> {}
  async transaction<T>(action: (database: PluginDatabase) => Promise<T>): Promise<T> { return action(this) }
  async run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
    if (sql.startsWith('INSERT INTO outbox_state')) {
      const [device, next, ack, drops, through] = params as [string, number, number, number, number]
      if (!this.state.has(device)) this.state.set(device, { next_sequence: next, acknowledged_sequence: ack, dropped_count: drops, dropped_through: through })
    } else if (sql.startsWith('INSERT INTO outbox_records')) {
      const [device_id, sequence, captured_at, received_at, payload, payload_bytes] = params as [string, number, number, number, string, number]
      this.records.push({ device_id, sequence, captured_at, received_at, payload, payload_bytes })
    } else if (sql.startsWith('UPDATE outbox_state SET next_sequence')) {
      const [next, device] = params as [number, string]
      this.state.get(device)!.next_sequence = next
    } else if (sql.startsWith('UPDATE outbox_state SET acknowledged_sequence')) {
      const [ack, device] = params as [number, string]
      this.state.get(device)!.acknowledged_sequence = ack
    } else if (sql.startsWith('DELETE FROM outbox_records')) {
      const [device, through] = params as [string, number]
      this.records = this.records.filter((row) => row.device_id !== device || row.sequence > through)
    } else if (sql.includes('dropped_count = dropped_count')) {
      const [count, through, , device] = params as [number, number, number, string]
      const state = this.state.get(device)!
      state.dropped_count += count
      state.dropped_through = Math.max(state.dropped_through, through)
    } else throw new Error(`Unhandled SQL: ${sql}`)
    return { changes: 1, lastInsertRowid: 0 }
  }
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const device = String(params[0])
    if (sql.startsWith('SELECT next_sequence')) return [this.state.get(device)] as T[]
    const matching = this.records.filter((row) => row.device_id === device).sort((a, b) => a.sequence - b.sequence)
    if (sql.includes('sequence > ?')) {
      const after = Number(params[1]); const limit = Number(params[2])
      return matching.filter((row) => row.sequence > after).slice(0, limit).map(({ payload }) => ({ payload })) as T[]
    }
    if (sql.includes('ORDER BY sequence DESC')) return matching.slice(-1).map(({ payload }) => ({ payload })) as T[]
    if (sql.includes('COUNT(*)')) return [{ message_count: matching.length, storage_bytes: matching.reduce((sum, row) => sum + row.payload_bytes, 0), oldest_captured_at: matching[0]?.captured_at ?? null }] as T[]
    if (sql.startsWith('SELECT sequence, payload_bytes')) return matching.map(({ sequence, payload_bytes }) => ({ sequence, payload_bytes })) as T[]
    if (sql.startsWith('SELECT sequence, captured_at')) return matching.map(({ sequence, captured_at }) => ({ sequence, captured_at })) as T[]
    throw new Error(`Unhandled SQL: ${sql}`)
  }
}

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
const draft = (capturedAt: number) => ({ capturedAt, receivedAt: capturedAt, values: { lat: -27, lon: 153 }, quality: { timestamp: 'source' as const } })

describe('outbox retention pressure', () => {
  it('FileOutbox reports cumulative lifetime drops and keeps the newest durable records', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-file-'))
    directories.push(dir)
    const outbox = new FileOutbox(dir, { maxBytes: 400, maxAgeMs: 7 * 86_400_000, segmentBytes: 260, now: () => 10_000 })
    await outbox.open()
    for (let index = 1; index <= 12; index += 1) await outbox.append('dev_1', draft(index * 1000))
    const stats = await outbox.stats()
    expect(stats.droppedCount).toBeGreaterThan(0)
    expect(stats.droppedThrough).toBeGreaterThan(0)
    const pending = await outbox.pending(100, 1_000_000)
    expect(pending.length).toBe(stats.messageCount)
    expect(pending[0]!.sequence).toBe(stats.droppedThrough + 1)
    expect(pending[pending.length - 1]!.sequence).toBe(stats.currentSequence)
    await outbox.close()
  })

  it('DatabaseOutbox reports cumulative lifetime drops and keeps the newest durable records', async () => {
    const database = new MemoryDatabase()
    const outbox = new DatabaseOutbox(database, 'device-1', { maxBytes: 1, maxAgeMs: 86_400_000, segmentBytes: 1024, now: () => 10_000 })
    await outbox.open()
    for (let index = 1; index <= 8; index += 1) await outbox.append('device-1', draft(index * 1000))
    const stats = await outbox.stats()
    expect(stats.droppedCount).toBeGreaterThan(0)
    expect(stats.currentSequence).toBe(8)
    expect((await outbox.pending(100, 1_000_000)).map((s) => s.sequence)).toEqual([8])
  })

  it('acknowledgement reclaims delivered records without touching lifetime drop counters', async () => {
    const database = new MemoryDatabase()
    const outbox = new DatabaseOutbox(database, 'device-1', { maxBytes: 1_000_000, maxAgeMs: 86_400_000, segmentBytes: 1024, now: () => 10_000 })
    await outbox.open()
    for (let index = 1; index <= 5; index += 1) await outbox.append('device-1', draft(index * 1000))
    await outbox.acknowledge(3)
    const stats = await outbox.stats()
    expect(stats).toMatchObject({ acknowledgedSequence: 3, currentSequence: 5, messageCount: 2, droppedCount: 0 })
    expect((await outbox.pending(100, 1_000_000)).map((s) => s.sequence)).toEqual([4, 5])
  })
})
