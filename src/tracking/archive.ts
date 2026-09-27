import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_TRACK_POINTS, selectTrackIndexes, type TrackPoint, type TrackResult } from './track'

// Durable onboard recording history.
//
// This archive is deliberately independent of the delivery outbox: an
// acknowledgement (or segment reclaim) must never remove the local map history.
// Each recording owns its own file of fixed 32-byte binary records, so a read
// computes the record count from the file size and seeks only the decimated
// record offsets. That keeps memory and work proportional to the display bound
// rather than to the recording length, and keeps appends O(1) and off the
// outbox's serial append/ACK lock.
const MAGIC = Buffer.from([0x57, 0x4c, 0x54, 0x31]) // "WLT1"
const HEADER_BYTES = 16
const RECORD_BYTES = 32

export interface TrackArchiveOptions {
  maxAgeMs?: number
  maxRecordings?: number
  maxBytes?: number
  now?: () => number
}

export interface TrackReadQuery {
  maxPoints?: number
  fromSequence?: number
  throughSequence?: number
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_RECORDINGS = 64
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

export function archiveFileName(recordingId: string): string {
  const safe = recordingId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'recording'
  const prefix = createHash('sha256').update(recordingId).digest('hex').slice(0, 16)
  return `${prefix}-${safe}.wlt`
}

export function encodeTrackRecord(point: TrackPoint): Buffer {
  const buffer = Buffer.allocUnsafe(RECORD_BYTES)
  buffer.writeDoubleLE(point.sequence, 0)
  buffer.writeDoubleLE(point.capturedAt, 8)
  buffer.writeDoubleLE(point.latitude, 16)
  buffer.writeDoubleLE(point.longitude, 24)
  return buffer
}

export function decodeTrackRecord(buffer: Buffer): TrackPoint {
  return {
    sequence: buffer.readDoubleLE(0),
    capturedAt: buffer.readDoubleLE(8),
    latitude: buffer.readDoubleLE(16),
    longitude: buffer.readDoubleLE(24)
  }
}

function headerBuffer(): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(header, 0)
  header.writeUInt32LE(RECORD_BYTES, 4)
  return header
}

function validPoint(point: TrackPoint): boolean {
  return Number.isSafeInteger(point.sequence)
    && Number.isFinite(point.capturedAt)
    && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
    && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180
}

export class TrackArchive {
  private readonly initialized = new Set<string>()
  private readonly maxAgeMs: number
  private readonly maxRecordings: number
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(private readonly directory: string, options: TrackArchiveOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.maxRecordings = options.maxRecordings ?? DEFAULT_MAX_RECORDINGS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.now = options.now ?? Date.now
  }

  async open(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
  }

  async append(recordingId: string, point: TrackPoint): Promise<void> {
    if (!recordingId || !validPoint(point)) return
    const target = this.target(recordingId)
    if (!this.initialized.has(target)) {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      let size = 0
      try { size = (await fs.stat(target)).size } catch { /* New file. */ }
      if (size === 0) await fs.appendFile(target, headerBuffer(), { mode: 0o600 })
      this.initialized.add(target)
    }
    await fs.appendFile(target, encodeTrackRecord(point), { mode: 0o600 })
  }

  async read(recordingId: string, query: TrackReadQuery = {}): Promise<TrackResult> {
    const empty: TrackResult = {
      storageBackend: 'archive',
      points: [],
      summary: { fromSequence: null, throughSequence: null, totalSamples: 0, decimated: false }
    }
    if (!recordingId) return empty
    let handle: fs.FileHandle
    try {
      handle = await fs.open(this.target(recordingId), 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty
      throw error
    }
    try {
      const size = (await handle.stat()).size
      if (size < HEADER_BYTES) return empty
      const header = Buffer.alloc(HEADER_BYTES)
      await handle.read(header, 0, HEADER_BYTES, 0)
      if (!header.subarray(0, 4).equals(MAGIC) || header.readUInt32LE(4) !== RECORD_BYTES) return empty
      const count = Math.floor((size - HEADER_BYTES) / RECORD_BYTES)
      if (count <= 0) return empty
      const indexes = selectTrackIndexes(count, query.maxPoints ?? DEFAULT_TRACK_POINTS)
      const record = Buffer.alloc(RECORD_BYTES)
      const points: TrackPoint[] = []
      for (const index of indexes) {
        const read = await handle.read(record, 0, RECORD_BYTES, HEADER_BYTES + index * RECORD_BYTES)
        if (read.bytesRead !== RECORD_BYTES) continue
        const point = decodeTrackRecord(record)
        if (!validPoint(point)) continue
        if (query.fromSequence !== undefined && point.sequence < query.fromSequence) continue
        if (query.throughSequence !== undefined && point.sequence > query.throughSequence) continue
        points.push(point)
      }
      return {
        storageBackend: 'archive',
        points,
        summary: {
          fromSequence: points[0]?.sequence ?? null,
          throughSequence: points[points.length - 1]?.sequence ?? null,
          totalSamples: count,
          decimated: points.length < count
        }
      }
    } finally {
      await handle.close()
    }
  }

  // Bounded retention. The active recording's file is never pruned, so a long
  // local-only passage keeps its full map history while settled older
  // recordings age out. Age is based on file modification time.
  async prune(activeRecordingId?: string | null): Promise<void> {
    let names: string[]
    try { names = (await fs.readdir(this.directory)).filter((name) => name.endsWith('.wlt')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const activeFile = activeRecordingId ? archiveFileName(activeRecordingId) : undefined
    const entries: Array<{ name: string; target: string; size: number; mtime: number }> = []
    for (const name of names) {
      if (name === activeFile) continue
      const target = path.join(this.directory, name)
      try {
        const stat = await fs.stat(target)
        entries.push({ name, target, size: stat.size, mtime: stat.mtimeMs })
      } catch { /* Raced with another prune. */ }
    }
    entries.sort((a, b) => a.mtime - b.mtime)
    const cutoff = this.now() - this.maxAgeMs
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    const keep = [...entries]
    while (keep.length && (keep.length > this.maxRecordings || total > this.maxBytes || keep[0]!.mtime < cutoff)) {
      const oldest = keep.shift()!
      total -= oldest.size
      await fs.rm(oldest.target, { force: true }).catch(() => undefined)
    }
  }

  private target(recordingId: string): string {
    return path.join(this.directory, archiveFileName(recordingId))
  }
}
