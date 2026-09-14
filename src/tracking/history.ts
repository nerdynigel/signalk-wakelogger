import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { OutboxStats } from '../outbox/interface'

export interface HistoricalUpload {
  id: string
  throughSequence: number
  startedAt: number
  totalSamples: number
  remainingSamples: number
  uploadedSamples: number
  droppedSamples: number
  progressKnown?: boolean
  completedAt?: number
}
interface Snapshot extends HistoricalUpload { baseSequence: number; initialDroppedCount: number }

export class UploadHistory {
  private snapshot?: Snapshot
  private operation: Promise<void> = Promise.resolve()
  constructor(private readonly target: string) {}
  async open(): Promise<void> {
    try {
      const value = JSON.parse(await fs.readFile(this.target, 'utf8')) as Snapshot
      if (typeof value.id !== 'string' || ![value.throughSequence, value.baseSequence, value.initialDroppedCount, value.totalSamples, value.remainingSamples, value.uploadedSamples, value.droppedSamples].every((count) => Number.isSafeInteger(count) && count >= 0)
        || value.totalSamples !== value.remainingSamples + value.uploadedSamples + value.droppedSamples) throw new Error('Invalid historical upload checkpoint')
      this.snapshot = value
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  current(): HistoricalUpload | undefined {
    if (!this.snapshot) return undefined
    const value: Partial<Snapshot> = { ...this.snapshot }
    delete value.baseSequence
    delete value.initialDroppedCount
    return value as HistoricalUpload
  }
  update(stats: OutboxStats, begin = false): Promise<void> {
    const operation = this.operation.then(async () => {
      let next = this.snapshot ? { ...this.snapshot } : undefined
      if (begin && stats.messageCount > 0 && (!next || next.completedAt !== undefined)) {
        const baseSequence = Math.max(stats.acknowledgedSequence, stats.droppedThrough)
        const totalSamples = Math.max(0, stats.currentSequence - baseSequence)
        if (totalSamples === 0) return
        next = { id: randomUUID(), throughSequence: stats.currentSequence, baseSequence, initialDroppedCount: stats.droppedCount,
          startedAt: Date.now(), progressKnown: true, totalSamples, remainingSamples: totalSamples, uploadedSamples: 0, droppedSamples: 0 }
      }
      if (!next || next.completedAt !== undefined) return
      // Aggregate outbox counters cannot attribute every loss if ACKs and
      // retention interleave. Conservatively report losses during catch-up;
      // never turn a discarded record into an uploaded record.
      next.remainingSamples = Math.max(0, Math.min(next.remainingSamples,
        next.throughSequence - Math.max(stats.acknowledgedSequence, stats.droppedThrough, next.baseSequence)))
      const lossesObserved = Math.max(0, stats.droppedCount - next.initialDroppedCount)
      if (lossesObserved > 0) next.progressKnown = false
      next.droppedSamples = Math.min(next.totalSamples - next.remainingSamples - next.uploadedSamples, Math.max(next.droppedSamples, lossesObserved))
      next.uploadedSamples = next.totalSamples - next.remainingSamples - next.droppedSamples
      if (next.remainingSamples === 0) next.completedAt = Date.now()
      if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return
      await durableJson(this.target, next)
      this.snapshot = next
    })
    this.operation = operation.catch(() => undefined)
    return operation
  }
  async close(): Promise<void> { await this.operation }
}

export async function durableJson(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'w', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() } finally { await handle.close() }
  await fs.rename(temporary, target)
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(target), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}
