import { describe, expect, it } from 'vitest'
import { DatabaseOutbox } from '../../src/outbox/database-outbox'
import type { PluginDatabase } from '../../src/outbox/database-types'

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
      if (params.length === 5) {
        const [next, ack, drops, through, device] = params as [number, number, number, number, string]
        this.state.set(device, { next_sequence: next, acknowledged_sequence: ack, dropped_count: drops, dropped_through: through })
      } else {
        const [next, device] = params as [number, string]
        this.state.get(device)!.next_sequence = next
      }
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

const draft = (capturedAt: number) => ({ capturedAt, receivedAt: capturedAt, values: { lat: -27, lon: 153 }, quality: { timestamp: 'source' as const } })

describe('DatabaseOutbox', () => {
  it('preserves monotonic sequence and acknowledgement state across reopen', async () => {
    const database = new MemoryDatabase()
    const options = { maxBytes: 1_000_000, maxAgeMs: 86_400_000, segmentBytes: 1024, now: () => 3_000 }
    const first = new DatabaseOutbox(database, 'device-1', options)
    await first.open()
    expect((await first.append('device-1', draft(1_000))).sequence).toBe(1)
    expect((await first.append('device-1', draft(2_000))).sequence).toBe(2)
    await first.acknowledge(1)
    await first.close()

    const reopened = new DatabaseOutbox(database, 'device-1', options)
    await reopened.open()
    expect((await reopened.append('device-1', draft(3_000))).sequence).toBe(3)
    expect((await reopened.pendingAfter(1, 10, 100_000)).map((item) => item.sequence)).toEqual([2, 3])
    expect(await reopened.stats()).toMatchObject({ storageBackend: 'database', acknowledgedSequence: 1, currentSequence: 3, messageCount: 2 })
  })

  it('drops oldest records at its bound while keeping the newest record and reporting the gap', async () => {
    const database = new MemoryDatabase()
    const outbox = new DatabaseOutbox(database, 'device-1', { maxBytes: 1, maxAgeMs: 1, segmentBytes: 1024, now: () => 10_000 })
    await outbox.open()
    await outbox.append('device-1', draft(1_000))
    await outbox.append('device-1', draft(2_000))
    const stats = await outbox.stats()
    expect(stats).toMatchObject({ currentSequence: 2, messageCount: 1, droppedCount: 1, droppedThrough: 1 })
    expect((await outbox.latest())?.sequence).toBe(2)
  })

  it('reconciles a previously initialized database with a later file-backend seed', async () => {
    const database = new MemoryDatabase()
    const options = { maxBytes: 1_000_000, maxAgeMs: 86_400_000, segmentBytes: 1024, now: () => 10_000 }
    const interruptedSelection = new DatabaseOutbox(database, 'device-1', options)
    await interruptedSelection.open(); await interruptedSelection.close()
    const selected = new DatabaseOutbox(database, 'device-1', options, {
      currentSequence: 42, acknowledgedSequence: 40, droppedCount: 2, droppedThrough: 12
    })
    await selected.open()
    expect((await selected.append('device-1', draft(10_000))).sequence).toBe(43)
    expect(await selected.stats()).toMatchObject({ acknowledgedSequence: 40, droppedCount: 2, droppedThrough: 12 })
  })
})
