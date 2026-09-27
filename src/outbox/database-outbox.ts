import type { TelemetryDraft, TelemetrySample } from '../telemetry/types'
import type { PluginDatabase } from './database-types'
import type { OutboxOptions, OutboxSeed, OutboxStats, OutboxStore } from './interface'

interface StateRow {
  next_sequence: number
  acknowledged_sequence: number
  dropped_count: number
  dropped_through: number
}

interface PayloadRow { payload: string }
interface AggregateRow { message_count: number; storage_bytes: number; oldest_captured_at: number | null }
interface SizeRow { sequence: number; payload_bytes: number }

const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS outbox_state (
      device_id TEXT PRIMARY KEY,
      next_sequence INTEGER NOT NULL,
      acknowledged_sequence INTEGER NOT NULL,
      dropped_count INTEGER NOT NULL,
      dropped_through INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox_records (
      device_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      PRIMARY KEY (device_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS ix_outbox_records_device_sequence ON outbox_records (device_id, sequence);
    CREATE INDEX IF NOT EXISTS ix_outbox_records_device_captured ON outbox_records (device_id, captured_at);
  `
}]

export class DatabaseOutbox implements OutboxStore {
  private opened = false
  private operation: Promise<void> = Promise.resolve()

  constructor(
    private readonly database: PluginDatabase,
    private readonly deviceId: string,
    private readonly options: OutboxOptions,
    private readonly seed?: OutboxSeed
  ) {}

  async open(): Promise<void> {
    await this.database.migrate(MIGRATIONS)
    const seed = this.seed ?? { currentSequence: 0, acknowledgedSequence: 0, droppedCount: 0, droppedThrough: 0 }
    await this.database.run(
      `INSERT INTO outbox_state (device_id, next_sequence, acknowledged_sequence, dropped_count, dropped_through)
       SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM outbox_state WHERE device_id = ?)`,
      [this.deviceId, seed.currentSequence + 1, seed.acknowledgedSequence, seed.droppedCount, seed.droppedThrough, this.deviceId]
    )
    if (this.seed) {
      const state = await this.readState(this.database)
      await this.database.run(
        `UPDATE outbox_state SET next_sequence = ?, acknowledged_sequence = ?, dropped_count = ?, dropped_through = ?
         WHERE device_id = ?`,
        [
          Math.max(Number(state.next_sequence), seed.currentSequence + 1),
          Math.max(Number(state.acknowledged_sequence), seed.acknowledgedSequence),
          Math.max(Number(state.dropped_count), seed.droppedCount),
          Math.max(Number(state.dropped_through), seed.droppedThrough),
          this.deviceId
        ]
      )
    }
    this.opened = true
    await this.enforceLimits()
  }

  append(deviceId: string, draft: TelemetryDraft): Promise<TelemetrySample> {
    return this.exclusive(async () => {
      this.assertOpen()
      if (deviceId !== this.deviceId) throw new Error('Outbox device identity does not match')
      const sample = await this.database.transaction(async (database) => {
        const state = await this.readState(database)
        const value: TelemetrySample = { v: 1, deviceId, sequence: state.next_sequence, ...draft }
        const payload = JSON.stringify(value)
        await database.run(
          'INSERT INTO outbox_records (device_id, sequence, captured_at, received_at, payload, payload_bytes) VALUES (?, ?, ?, ?, ?, ?)',
          [deviceId, value.sequence, value.capturedAt, value.receivedAt, payload, Buffer.byteLength(payload)]
        )
        await database.run('UPDATE outbox_state SET next_sequence = ? WHERE device_id = ?', [value.sequence + 1, deviceId])
        return value
      })
      await this.enforceLimitsUnlocked()
      return sample
    })
  }

  pending(limit: number, maxBytes: number): Promise<TelemetrySample[]> {
    return this.pendingAfter(0, limit, maxBytes)
  }

  pendingAfter(sequence: number, limit: number, maxBytes: number): Promise<TelemetrySample[]> {
    return this.exclusive(async () => {
      this.assertOpen()
      const rows = await this.database.query<PayloadRow>(
        'SELECT payload FROM outbox_records WHERE device_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?',
        [this.deviceId, sequence, Math.max(1, limit)]
      )
      const result: TelemetrySample[] = []
      let bytes = 0
      for (const row of rows) {
        const size = Buffer.byteLength(row.payload)
        if (result.length && bytes + size > maxBytes) break
        result.push(JSON.parse(row.payload) as TelemetrySample)
        bytes += size
      }
      return result
    })
  }

  acknowledge(sequence: number): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen()
      await this.database.transaction(async (database) => {
        const state = await this.readState(database)
        const maximum = state.next_sequence - 1
        if (!Number.isSafeInteger(sequence) || sequence <= state.acknowledged_sequence || sequence > maximum) return
        await database.run('UPDATE outbox_state SET acknowledged_sequence = ? WHERE device_id = ?', [sequence, this.deviceId])
        await database.run('DELETE FROM outbox_records WHERE device_id = ? AND sequence <= ?', [this.deviceId, sequence])
      })
    })
  }

  latest(): Promise<TelemetrySample | undefined> {
    return this.exclusive(async () => {
      this.assertOpen()
      const rows = await this.database.query<PayloadRow>(
        'SELECT payload FROM outbox_records WHERE device_id = ? ORDER BY sequence DESC LIMIT 1', [this.deviceId]
      )
      return rows[0] ? JSON.parse(rows[0].payload) as TelemetrySample : undefined
    })
  }

  stats(): Promise<OutboxStats> {
    return this.exclusive(async () => {
      this.assertOpen()
      const state = await this.readState(this.database)
      const rows = await this.database.query<AggregateRow>(
        `SELECT COUNT(*) AS message_count, COALESCE(SUM(payload_bytes), 0) AS storage_bytes,
                MIN(captured_at) AS oldest_captured_at FROM outbox_records WHERE device_id = ?`,
        [this.deviceId]
      )
      const aggregate = rows[0] ?? { message_count: 0, storage_bytes: 0, oldest_captured_at: null }
      return {
        storageBackend: 'database',
        messageCount: Number(aggregate.message_count),
        diskBytes: Number(aggregate.storage_bytes),
        oldestCapturedAt: aggregate.oldest_captured_at === null ? undefined : Number(aggregate.oldest_captured_at),
        acknowledgedSequence: Number(state.acknowledged_sequence),
        currentSequence: Number(state.next_sequence) - 1,
        droppedCount: Number(state.dropped_count),
        droppedThrough: Number(state.dropped_through)
      }
    })
  }

  async close(): Promise<void> {
    await this.operation
    this.opened = false
  }

  private async enforceLimits(): Promise<void> {
    await this.exclusive(() => this.enforceLimitsUnlocked())
  }

  private async enforceLimitsUnlocked(): Promise<void> {
    const now = this.options.now?.() ?? Date.now()
    const rows = await this.database.query<SizeRow>(
      'SELECT sequence, payload_bytes FROM outbox_records WHERE device_id = ? ORDER BY sequence ASC', [this.deviceId]
    )
    let total = rows.reduce((sum, row) => sum + Number(row.payload_bytes), 0)
    const cutoff = now - this.options.maxAgeMs
    const capturedRows = await this.database.query<{ sequence: number; captured_at: number }>(
      'SELECT sequence, captured_at FROM outbox_records WHERE device_id = ? ORDER BY sequence ASC', [this.deviceId]
    )
    let dropThrough = 0
    let dropCount = 0
    for (let index = 0; index < rows.length - 1; index += 1) {
      const row = rows[index]
      const captured = capturedRows[index]
      if (!row || !captured) continue
      const tooOld = Number(captured.captured_at) < cutoff
      if (!tooOld && total <= this.options.maxBytes) break
      total -= Number(row.payload_bytes)
      dropThrough = Number(row.sequence)
      dropCount += 1
    }
    if (!dropCount) return
    await this.database.transaction(async (database) => {
      await database.run('DELETE FROM outbox_records WHERE device_id = ? AND sequence <= ?', [this.deviceId, dropThrough])
      await database.run(
        `UPDATE outbox_state SET dropped_count = dropped_count + ?,
         dropped_through = CASE WHEN dropped_through > ? THEN dropped_through ELSE ? END WHERE device_id = ?`,
        [dropCount, dropThrough, dropThrough, this.deviceId]
      )
    })
  }

  private async readState(database: PluginDatabase): Promise<StateRow> {
    const rows = await database.query<StateRow>(
      'SELECT next_sequence, acknowledged_sequence, dropped_count, dropped_through FROM outbox_state WHERE device_id = ?',
      [this.deviceId]
    )
    if (!rows[0]) throw new Error('Outbox state is unavailable')
    return rows[0]
  }

  private assertOpen(): void {
    if (!this.opened) throw new Error('Outbox is not open')
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }
}
