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
  tracking: { courseId: string; racePlanId: number | null; activeIndex: number; totalPoints: number; reverse: boolean }
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

export interface StoredSnapshot {
  sequence: number
  at: number
  snapshot: OnboardPlanSnapshot
  published: boolean
}

interface SnapshotFile {
  version: 1
  nextSequence: number
  latest: StoredSnapshot | null
  events: StoredSnapshot[]
}

const MAX_EVENTS = 100

export class OnboardSnapshotStore {
  private snapshot: SnapshotFile = { version: 1, nextSequence: 1, latest: null, events: [] }
  private operation: Promise<void> = Promise.resolve()

  constructor(private readonly target: string) {}

  async open(): Promise<void> {
    try {
      const stored = JSON.parse(await fs.readFile(this.target, 'utf8')) as SnapshotFile
      if (stored.version !== 1 || !Number.isSafeInteger(stored.nextSequence) || stored.nextSequence < 1 || !Array.isArray(stored.events)) throw new Error('onboard_snapshot_checkpoint_invalid')
      for (const event of stored.events) {
        if (!Number.isSafeInteger(event.sequence) || typeof event.published !== 'boolean' || !event.snapshot) throw new Error('onboard_snapshot_checkpoint_invalid')
      }
      if (stored.latest && !stored.latest.snapshot) throw new Error('onboard_snapshot_checkpoint_invalid')
      this.snapshot = stored
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  latest(): OnboardPlanSnapshot | null { return this.snapshot.latest?.snapshot ?? null }
  latestStored(): StoredSnapshot | null { return this.snapshot.latest }

  append(snapshot: OnboardPlanSnapshot, at: number): Promise<number> {
    return this.exclusive(async () => {
      const sequence = this.snapshot.nextSequence
      const event: StoredSnapshot = { sequence, at, snapshot, published: false }
      const events = [...this.snapshot.events, event].slice(-MAX_EVENTS)
      this.snapshot = { version: 1, nextSequence: sequence + 1, latest: event, events }
      await this.persist(this.snapshot)
      return sequence
    })
  }

  pending(): StoredSnapshot[] { return this.snapshot.events.filter((event) => !event.published) }

  markPublished(sequences: number[]): Promise<void> {
    return this.exclusive(async () => {
      const set = new Set(sequences)
      this.snapshot = { ...this.snapshot, events: this.snapshot.events.map((event) => set.has(event.sequence) ? { ...event, published: true } : event) }
      await this.persist(this.snapshot)
    })
  }

  async close(): Promise<void> { await this.operation }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async persist(value: SnapshotFile): Promise<void> {
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
