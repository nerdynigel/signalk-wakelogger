import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { TelemetryDraft, TelemetrySample } from '../telemetry/types'
import type { OutboxOptions, OutboxStats, OutboxStore } from './interface'

const HEADER_BYTES = 4
const CHECKSUM_BYTES = 32
const META_FILE = 'metadata.json'
const SEGMENT_PATTERN = /^segment-(\d{12})\.log$/

interface Metadata {
  version: 1
  nextSequence: number
  acknowledgedSequence: number
  droppedCount: number
  droppedThrough: number
}

interface SegmentRecord { sample: TelemetrySample; start: number; end: number }
interface SegmentContents { name: string; records: SegmentRecord[]; bytes: number }

export class FileOutbox implements OutboxStore {
  private metadata: Metadata = { version: 1, nextSequence: 1, acknowledgedSequence: 0, droppedCount: 0, droppedThrough: 0 }
  private opened = false
  private operation: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string, private readonly options: OutboxOptions) {}

  async open(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    this.metadata = await this.readMetadata()
    const segments = await this.readSegments(true)
    const maximum = segments.flatMap((s) => s.records).reduce((value, r) => Math.max(value, r.sample.sequence), 0)
    const accountedThrough = Math.max(maximum, this.metadata.acknowledgedSequence, this.metadata.droppedThrough)
    if (this.metadata.nextSequence > accountedThrough + 1) {
      this.metadata.droppedCount += this.metadata.nextSequence - accountedThrough - 1
      this.metadata.droppedThrough = this.metadata.nextSequence - 1
    }
    this.metadata.nextSequence = Math.max(this.metadata.nextSequence, maximum + 1)
    await this.persistMetadata()
    this.opened = true
    await this.enforceLimits()
  }

  async append(deviceId: string, draft: TelemetryDraft): Promise<TelemetrySample> {
    return this.exclusive(async () => {
      this.assertOpen()
      const sample: TelemetrySample = { v: 1, deviceId, sequence: this.metadata.nextSequence, ...draft }
      const record = encodeRecord(sample)
      const segments = await this.segmentNames()
      let segment = segments.at(-1)
      let rotated = false
      if (!segment || (await fileSize(path.join(this.directory, segment))) + record.length > this.options.segmentBytes) {
        segment = segmentName(sample.sequence)
        rotated = true
      }
      const handle = await fs.open(path.join(this.directory, segment), 'a', 0o600)
      try {
        await handle.write(record)
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.metadata.nextSequence = sample.sequence + 1
      // Normal recovery derives nextSequence from the last checksummed record. Persist it
      // only at segment boundaries to avoid a second fsync for every one-second sample.
      if (rotated) await this.persistMetadata()
      await this.enforceLimitsUnlocked()
      return sample
    })
  }

  async pending(limit: number, maxBytes: number): Promise<TelemetrySample[]> {
    return this.pendingAfter(0, limit, maxBytes)
  }

  async pendingAfter(sequence: number, limit: number, maxBytes: number): Promise<TelemetrySample[]> {
    return this.exclusive(async () => {
      this.assertOpen()
      const result: TelemetrySample[] = []
      let bytes = 0
      for (const segment of await this.readSegments(false)) {
        for (const { sample } of segment.records) {
          if (sample.sequence <= Math.max(this.metadata.acknowledgedSequence, sequence)) continue
          const size = Buffer.byteLength(JSON.stringify(sample))
          if (result.length > 0 && (result.length >= limit || bytes + size > maxBytes)) return result
          result.push(sample)
          bytes += size
        }
      }
      return result
    })
  }

  async acknowledge(sequence: number): Promise<void> {
    await this.exclusive(async () => {
      this.assertOpen()
      const maximum = this.metadata.nextSequence - 1
      if (!Number.isSafeInteger(sequence) || sequence <= this.metadata.acknowledgedSequence || sequence > maximum) return
      this.metadata.acknowledgedSequence = sequence
      await this.persistMetadata()
      await this.reclaimAcknowledgedSegments()
    })
  }

  async latest(): Promise<TelemetrySample | undefined> {
    return this.exclusive(async () => {
      const segments = await this.readSegments(false)
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const sample = segments[index]?.records.at(-1)?.sample
        if (sample) return sample
      }
      return undefined
    })
  }

  async stats(): Promise<OutboxStats> {
    return this.exclusive(async () => {
      const segments = await this.readSegments(false)
      const pending = segments.flatMap((segment) => segment.records)
        .filter((record) => record.sample.sequence > this.metadata.acknowledgedSequence)
      return {
        storageBackend: 'file',
        messageCount: pending.length,
        diskBytes: segments.reduce((total, segment) => total + segment.bytes, 0),
        oldestCapturedAt: pending[0]?.sample.capturedAt,
        acknowledgedSequence: this.metadata.acknowledgedSequence,
        currentSequence: this.metadata.nextSequence - 1,
        droppedCount: this.metadata.droppedCount,
        droppedThrough: this.metadata.droppedThrough
      }
    })
  }

  async close(): Promise<void> {
    await this.operation
    if (this.opened) await this.persistMetadata()
    this.opened = false
  }

  private async enforceLimits(): Promise<void> {
    await this.exclusive(() => this.enforceLimitsUnlocked())
  }

  private async enforceLimitsUnlocked(): Promise<void> {
    const segments = await this.readSegments(false)
    let total = segments.reduce((sum, segment) => sum + segment.bytes, 0)
    const now = this.options.now?.() ?? Date.now()
    const cutoff = now - this.options.maxAgeMs
    let metadataChanged = false
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      if (!segment) continue
      const newest = segment.records.at(-1)?.sample
      const tooOld = newest !== undefined && newest.capturedAt < cutoff
      if (!tooOld && total <= this.options.maxBytes) break
      const unacknowledged = segment.records.filter((record) => record.sample.sequence > this.metadata.acknowledgedSequence)
      if (unacknowledged.length) {
        this.metadata.droppedCount += unacknowledged.length
        this.metadata.droppedThrough = unacknowledged.at(-1)?.sample.sequence ?? this.metadata.droppedThrough
        metadataChanged = true
      }
      await fs.unlink(path.join(this.directory, segment.name)).catch(ignoreMissing)
      total -= segment.bytes
    }
    if (metadataChanged) await this.persistMetadata()
  }

  private async reclaimAcknowledgedSegments(): Promise<void> {
    const segments = await this.readSegments(false)
    for (const segment of segments.slice(0, -1)) {
      const lastSequence = segment.records.at(-1)?.sample.sequence ?? 0
      if (lastSequence > this.metadata.acknowledgedSequence) break
      await fs.unlink(path.join(this.directory, segment.name)).catch(ignoreMissing)
    }
  }

  private async readMetadata(): Promise<Metadata> {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, META_FILE), 'utf8')) as Partial<Metadata>
      if (value.version === 1 && positiveInteger(value.nextSequence) && nonNegativeInteger(value.acknowledgedSequence)) {
        return {
          version: 1,
          nextSequence: value.nextSequence,
          acknowledgedSequence: value.acknowledgedSequence,
          droppedCount: nonNegativeInteger(value.droppedCount) ? value.droppedCount : 0,
          droppedThrough: nonNegativeInteger(value.droppedThrough) ? value.droppedThrough : 0
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    return { version: 1, nextSequence: 1, acknowledgedSequence: 0, droppedCount: 0, droppedThrough: 0 }
  }

  private async persistMetadata(): Promise<void> {
    const target = path.join(this.directory, META_FILE)
    const temporary = `${target}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(this.metadata)}\n`, { mode: 0o600 })
    const handle = await fs.open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, target)
  }

  private async readSegments(repair: boolean): Promise<SegmentContents[]> {
    const result: SegmentContents[] = []
    for (const name of await this.segmentNames()) {
      const target = path.join(this.directory, name)
      const data = await fs.readFile(target)
      const records: SegmentRecord[] = []
      let offset = 0
      while (offset + HEADER_BYTES + CHECKSUM_BYTES <= data.length) {
        const length = data.readUInt32BE(offset)
        const end = offset + HEADER_BYTES + length + CHECKSUM_BYTES
        if (length === 0 || length > this.options.segmentBytes || end > data.length) break
        const payload = data.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length)
        const expected = data.subarray(offset + HEADER_BYTES + length, end)
        const actual = createHash('sha256').update(payload).digest()
        if (!actual.equals(expected)) break
        try {
          const sample = JSON.parse(payload.toString('utf8')) as TelemetrySample
          if (!validSample(sample)) break
          records.push({ sample, start: offset, end })
          offset = end
        } catch {
          break
        }
      }
      if (repair && offset !== data.length) await fs.truncate(target, offset)
      result.push({ name, records, bytes: repair ? offset : data.length })
    }
    return result
  }

  private async segmentNames(): Promise<string[]> {
    return (await fs.readdir(this.directory)).filter((name) => SEGMENT_PATTERN.test(name)).sort()
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

function encodeRecord(sample: TelemetrySample): Buffer {
  const payload = Buffer.from(JSON.stringify(sample), 'utf8')
  const result = Buffer.allocUnsafe(HEADER_BYTES + payload.length + CHECKSUM_BYTES)
  result.writeUInt32BE(payload.length, 0)
  payload.copy(result, HEADER_BYTES)
  createHash('sha256').update(payload).digest().copy(result, HEADER_BYTES + payload.length)
  return result
}

function segmentName(sequence: number): string { return `segment-${String(sequence).padStart(12, '0')}.log` }
function validSample(value: TelemetrySample): boolean {
  return value?.v === 1 && typeof value.deviceId === 'string' && positiveInteger(value.sequence) &&
    Number.isFinite(value.capturedAt) && Number.isFinite(value.receivedAt) &&
    Number.isFinite(value.values?.lat) && Number.isFinite(value.values?.lon)
}
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function ignoreMissing(error: unknown): void { if (!isMissing(error)) throw error }
async function fileSize(target: string): Promise<number> { try { return (await fs.stat(target)).size } catch (e) { if (isMissing(e)) return 0; throw e } }
