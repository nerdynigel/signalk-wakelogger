import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProgressionDetection } from './detection'

export type ProgressionMode = 'auto' | 'suggest' | 'off'
export type ProgressionAction = 'detected' | 'auto_applied' | 'accepted' | 'dismissed' | 'wrong_side' | 'observed'

export interface RaceEvidence {
  sequence: number
  at: number
  action: ProgressionAction
  mode: ProgressionMode
  detection: ProgressionDetection
  published: boolean
}

interface Snapshot { version: 1; mode?: ProgressionMode; nextSequence: number; events: RaceEvidence[] }

const MAX_EVENTS = 500

export class RaceProgressionStore {
  private snapshot: Snapshot = { version: 1, nextSequence: 1, events: [] }
  private operation: Promise<void> = Promise.resolve()
  constructor(private readonly target: string) {}

  async open(): Promise<void> {
    try {
      const stored = JSON.parse(await fs.readFile(this.target, 'utf8')) as Snapshot
      if (stored.version !== 1 || !Number.isSafeInteger(stored.nextSequence) || stored.nextSequence < 1 || !Array.isArray(stored.events)) throw new Error('race_progression_checkpoint_invalid')
      if (stored.mode !== undefined && !['auto', 'suggest', 'off'].includes(stored.mode)) throw new Error('race_progression_checkpoint_invalid')
      for (const event of stored.events) {
        if (!Number.isSafeInteger(event.sequence) || typeof event.published !== 'boolean' || !event.detection) throw new Error('race_progression_checkpoint_invalid')
      }
      this.snapshot = stored
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  mode(): ProgressionMode | undefined { return this.snapshot.mode }

  setMode(mode: ProgressionMode): Promise<void> {
    return this.exclusive(async () => {
      this.snapshot = { ...this.snapshot, mode }
      await this.persist(this.snapshot)
    })
  }

  append(action: ProgressionAction, mode: ProgressionMode, detection: ProgressionDetection, at: number): Promise<number> {
    return this.exclusive(async () => {
      const sequence = this.snapshot.nextSequence
      const events = [...this.snapshot.events, { sequence, at, action, mode, detection, published: false }].slice(-MAX_EVENTS)
      this.snapshot = { ...this.snapshot, nextSequence: sequence + 1, events }
      await this.persist(this.snapshot)
      return sequence
    })
  }

  pending(): RaceEvidence[] { return this.snapshot.events.filter((event) => !event.published) }
  latest(): RaceEvidence | undefined { return this.snapshot.events.at(-1) }

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

  private async persist(value: Snapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 })
    const temporary = `${this.target}.tmp`
    const handle = await fs.open(temporary, 'w', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, this.target)
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(this.target), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
}