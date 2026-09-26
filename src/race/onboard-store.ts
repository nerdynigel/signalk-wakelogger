import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SailingAverages } from './averages'
import type { OnboardPlan } from './plan'

export interface OnboardPlanSnapshot {
  v: 1
  kind: 'race_plan_snapshot'
  id: string
  generatedAt: number
  source: 'onboard'
  packId: string | null
  packRevision: number
  packSha256: string
  ruleSetVersion: string
  tracking: { trackingSessionId?: string | null; courseId: string; racePlanId: number | null; activeIndex: number; totalPoints: number; reverse: boolean }
  observations: SailingAverages
  position: { latitude: number; longitude: number } | null
  activeLegSequence: number | null
  completedLegCount: number
  estimatedFinishAt: string | null
  remainingDurationSeconds: number | null
  legCount: number
  forecastCoverage: 'complete' | 'partial'
  warning: string | null
  plan: OnboardPlan
}

// Durable delivery lifecycle: a snapshot is only removed once Wake Logger has
// application-ACKed it. MQTT publish (QoS 1) proves broker receipt only.
export type SnapshotDeliveryState = 'pending' | 'published' | 'acknowledged'

export interface StoredSnapshot {
  sequence: number
  at: number
  snapshot: OnboardPlanSnapshot
  state: SnapshotDeliveryState
  attempts: number
  firstPublishedAt?: number
  lastAttemptAt?: number
  acknowledgedAt?: number
}

interface SnapshotFileV2 {
  version: 2
  nextSequence: number
  latest: StoredSnapshot | null
  events: StoredSnapshot[]
}
interface SnapshotFileV1 {
  version: 1
  nextSequence: number
  latest: { sequence: number; at: number; snapshot: OnboardPlanSnapshot; published: boolean } | null
  events: Array<{ sequence: number; at: number; snapshot: OnboardPlanSnapshot; published: boolean }>
}

const MAX_EVENTS = 100
// Acknowledged snapshots are retained briefly for diagnostics, then evicted.
const ACKNOWLEDGED_RETENTION_MS = 24 * 60 * 60 * 1000

export class OnboardSnapshotStore {
  private snapshot: SnapshotFileV2 = { version: 2, nextSequence: 1, latest: null, events: [] }
  private operation: Promise<void> = Promise.resolve()

  constructor(private readonly target: string) {}

  async open(): Promise<void> {
    try {
      const stored = JSON.parse(await fs.readFile(this.target, 'utf8')) as SnapshotFileV1 | SnapshotFileV2
      if (stored.version === 1) {
        this.snapshot = {
          version: 2,
          nextSequence: stored.nextSequence,
          latest: stored.latest ? migrate(stored.latest) : null,
          events: stored.events.map(migrate)
        }
        await this.persist(this.snapshot)
        return
      }
      if (stored.version !== 2 || !Number.isSafeInteger(stored.nextSequence) || stored.nextSequence < 1 || !Array.isArray(stored.events)) throw new Error('onboard_snapshot_checkpoint_invalid')
      for (const event of stored.events) {
        if (!Number.isSafeInteger(event.sequence) || !['pending', 'published', 'acknowledged'].includes(event.state) || !event.snapshot || !Number.isSafeInteger(event.attempts)) throw new Error('onboard_snapshot_checkpoint_invalid')
      }
      if (stored.latest && !stored.latest.snapshot) throw new Error('onboard_snapshot_checkpoint_invalid')
      this.snapshot = stored
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  latest(): OnboardPlanSnapshot | null { return this.snapshot.latest?.snapshot ?? null }
  latestStored(): StoredSnapshot | null { return this.snapshot.latest }

  /** Snapshots that have never been MQTT-published. */
  pending(): StoredSnapshot[] { return this.snapshot.events.filter((event) => event.state === 'pending') }

  /** Snapshots that were published but not yet application-ACKed; retry these. */
  unacknowledged(): StoredSnapshot[] { return this.snapshot.events.filter((event) => event.state === 'published') }

  append(snapshot: OnboardPlanSnapshot, at: number): Promise<number> {
    return this.exclusive(async () => {
      const sequence = this.snapshot.nextSequence
      const event: StoredSnapshot = { sequence, at, snapshot, state: 'pending', attempts: 0 }
      const events = this.prune([...this.snapshot.events, event], at)
      this.snapshot = { version: 2, nextSequence: sequence + 1, latest: event, events }
      await this.persist(this.snapshot)
      return sequence
    })
  }

  markPublished(sequences: number[], at = Date.now()): Promise<void> {
    return this.exclusive(async () => {
      const set = new Set(sequences)
      const events = this.snapshot.events.map((event) => set.has(event.sequence) && event.state !== 'acknowledged'
        ? { ...event, state: 'published' as const, attempts: event.attempts + 1, firstPublishedAt: event.firstPublishedAt ?? at, lastAttemptAt: at }
        : event)
      this.snapshot = { ...this.snapshot, events }
      await this.persist(this.snapshot)
    })
  }

  /** Mark snapshots acknowledged by their durable snapshot id. Duplicate ids are harmless. */
  acknowledge(ids: string[], at = Date.now()): Promise<number> {
    return this.exclusive(async () => {
      const set = new Set(ids)
      let acknowledged = 0
      const events = this.snapshot.events.map((event) => {
        if (!set.has(event.snapshot.id) || event.state === 'acknowledged') return event
        acknowledged += 1
        return { ...event, state: 'acknowledged' as const, acknowledgedAt: at }
      })
      if (acknowledged === 0) return 0
      this.snapshot = { ...this.snapshot, events: this.prune(events, at) }
      await this.persist(this.snapshot)
      return acknowledged
    })
  }

  async close(): Promise<void> { await this.operation }

  private prune(events: StoredSnapshot[], now: number): StoredSnapshot[] {
    const cutoff = now - ACKNOWLEDGED_RETENTION_MS
    let kept = events.filter((event) => !(event.state === 'acknowledged' && (event.acknowledgedAt ?? 0) < cutoff))
    if (kept.length > MAX_EVENTS) {
      // Deterministic eviction: oldest acknowledged first, then oldest overall.
      const over = kept.length - MAX_EVENTS
      const drop = new Set(kept.filter((event) => event.state === 'acknowledged').sort((left, right) => left.sequence - right.sequence).slice(0, over).map((event) => event.sequence))
      kept = kept.filter((event) => !drop.has(event.sequence))
    }
    if (kept.length > MAX_EVENTS) kept = kept.slice(-MAX_EVENTS)
    return kept
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist(value: SnapshotFileV2): Promise<void> {
    await fs.mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 })
    const temporary = `${this.target}.${randomUUID()}.tmp`
    const handle = await fs.open(temporary, 'w', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, this.target)
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(this.target), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
}

// A v1 checkpoint tracked only MQTT publication, so published events become
// durable published-but-unacknowledged snapshots and will be re-sent until the
// application ACK arrives.
function migrate(event: { sequence: number; at: number; snapshot: OnboardPlanSnapshot; published: boolean }): StoredSnapshot {
  return { sequence: event.sequence, at: event.at, snapshot: event.snapshot, state: event.published ? 'published' : 'pending', attempts: event.published ? 1 : 0, firstPublishedAt: event.published ? event.at : undefined }
}
