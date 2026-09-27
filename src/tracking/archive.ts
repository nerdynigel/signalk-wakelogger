import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_TRACK_POINTS, selectTrackIndexes, type TrackPoint, type TrackResult } from './track'

// Durable onboard recording history.
//
// This archive is deliberately independent of the delivery outbox and of the
// pending-upload manifest store: an acknowledgement (or an ACKed manifest being
// removed) must never remove local map history or hide a completed recording
// from GET /track. Each recording owns its own file of fixed 32-byte binary
// records, plus an independent `manifest.json` describing every recording, so
// the current or most recent completed recording stays discoverable after its
// upload manifests are acknowledged and removed.
//
// Durability policy (demonstrated by tests):
//  - appends are serialised per archive, never interleaved or out of order;
//  - a completed append is durable across an OS process restart (the write
//    syscall has returned and the data lives in the OS page cache);
//  - the manifest is written atomically and fsynced on close/settle;
//  - power-loss durability is NOT claimed per append: on the next open a
//    trailing partial record is truncated, a partial header is repaired and a
//    corrupt header is quarantined before further appends.
const MAGIC = Buffer.from([0x57, 0x4c, 0x54, 0x31]) // "WLT1"
const HEADER_BYTES = 16
const RECORD_BYTES = 32
const MANIFEST_FILE = 'manifest.json'

export interface TrackArchiveOptions {
  maxAgeMs?: number
  maxRecordings?: number
  maxBytes?: number
  /** Maximum queued, not-yet-written appends before the archive reports failure. */
  maxPendingWrites?: number
  now?: () => number
}

export interface TrackReadQuery {
  maxPoints?: number
  fromSequence?: number
  throughSequence?: number
}

export interface ArchiveRecordingMeta {
  id: string
  file: string
  firstSequence: number | null
  lastSequence: number | null
  points: number
  startedAt: number | null
  lastCapturedAt: number | null
  endedAt: number | null
  closed: boolean
}

interface ArchiveManifest {
  version: 1
  currentRecordingId: string | null
  recordings: ArchiveRecordingMeta[]
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_RECORDINGS = 64
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_PENDING_WRITES = 512
const MANIFEST_FLUSH_EVERY = 30

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

function recordCount(size: number): number {
  if (size < HEADER_BYTES) return 0
  return Math.floor((size - HEADER_BYTES) / RECORD_BYTES)
}

export class TrackArchive {
  private manifest: ArchiveManifest = { version: 1, currentRecordingId: null, recordings: [] }
  private operation: Promise<void> = Promise.resolve()
  private pendingWrites = 0
  private appendsSinceFlush = 0
  private lastError: string | undefined
  // Expected on-disk size per archive file; a mismatch triggers recovery so an
  // externally truncated or interrupted tail is repaired before the next append.
  private readonly knownSize = new Map<string, number>()
  private readonly maxAgeMs: number
  private readonly maxRecordings: number
  private readonly maxBytes: number
  private readonly maxPendingWrites: number
  private readonly now: () => number

  constructor(private readonly directory: string, options: TrackArchiveOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.maxRecordings = options.maxRecordings ?? DEFAULT_MAX_RECORDINGS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxPendingWrites = options.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES
    this.now = options.now ?? Date.now
  }

  async open(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stored = await this.readManifest()
    if (stored) this.manifest = stored
    else await this.rebuildManifest()
    // Recover the current recording's tail so the first append is aligned.
    if (this.manifest.currentRecordingId) {
      const meta = this.ensureMeta(this.manifest.currentRecordingId)
      try { await this.recoverFile(this.manifest.currentRecordingId, meta) } catch { /* Recovery is best effort on open. */ }
    }
  }

  /** The current recording id: the last appended, else the most recent by capture time. */
  currentRecordingId(): string | null {
    if (this.manifest.currentRecordingId) return this.manifest.currentRecordingId
    return this.mostRecentRecording()?.id ?? null
  }

  mostRecentRecording(): ArchiveRecordingMeta | null {
    const closedOrOpen = [...this.manifest.recordings]
    if (!closedOrOpen.length) return null
    closedOrOpen.sort((a, b) => (b.lastCapturedAt ?? b.startedAt ?? 0) - (a.lastCapturedAt ?? a.startedAt ?? 0))
    return closedOrOpen[0] ?? null
  }

  recordingMeta(recordingId: string): ArchiveRecordingMeta | null {
    return this.manifest.recordings.find((entry) => entry.id === recordingId) ?? null
  }

  lastFailure(): string | undefined { return this.lastError }

  async append(recordingId: string, point: TrackPoint): Promise<void> {
    if (!recordingId || !validPoint(point)) return
    if (this.pendingWrites >= this.maxPendingWrites) {
      this.lastError = 'track_archive_backlog'
      throw new Error('track_archive_backlog')
    }
    this.pendingWrites += 1
    const run = this.operation.then(async () => { await this.appendInternal(recordingId, point) })
    this.operation = run.then(() => undefined, (error) => { this.lastError = error instanceof Error ? error.message : String(error) })
    try {
      await run
    } finally {
      this.pendingWrites -= 1
    }
  }

  async markClosed(recordingId: string, endedAt?: number | null): Promise<void> {
    const run = this.operation.then(async () => {
      const meta = this.recordingMeta(recordingId)
      if (!meta) return
      meta.closed = true
      meta.endedAt = Number.isFinite(endedAt) ? endedAt as number : meta.lastCapturedAt
      await this.persistManifest()
    })
    this.operation = run.then(() => undefined, () => undefined)
    return run
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
      const count = recordCount(size)
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
  // recordings age out. Age is based on the manifest's last capture time, with
  // file mtime as a fallback.
  async prune(activeRecordingId?: string | null): Promise<void> {
    const active = activeRecordingId ?? this.currentRecordingId()
    const entries: Array<{ entry: ArchiveRecordingMeta; target: string; age: number; size: number }> = []
    for (const entry of this.manifest.recordings) {
      if (entry.id === active) continue
      const target = this.target(entry.id)
      let size = 0
      try { size = (await fs.stat(target)).size } catch { size = 0 }
      entries.push({ entry, target, age: entry.lastCapturedAt ?? entry.startedAt ?? this.now(), size })
    }
    entries.sort((a, b) => a.age - b.age)
    const cutoff = this.now() - this.maxAgeMs
    let total = entries.reduce((sum, item) => sum + item.size, 0)
    const removed = new Set<string>()
    for (const { entry, target, age, size } of entries) {
      const overCount = this.manifest.recordings.length - removed.size > this.maxRecordings
      const overBytes = total > this.maxBytes
      if (!(overCount || overBytes || age < cutoff)) break
      await fs.rm(target, { force: true }).catch(() => undefined)
      total -= size
      removed.add(entry.id)
    }
    const changed = removed.size > 0
    if (changed) {
      this.manifest.recordings = this.manifest.recordings.filter((entry) => !removed.has(entry.id))
      if (this.manifest.currentRecordingId && removed.has(this.manifest.currentRecordingId)) this.manifest.currentRecordingId = null
      await this.persistManifest()
    }
  }

  async flush(): Promise<void> {
    await this.operation.catch(() => undefined)
    if (this.appendsSinceFlush > 0) {
      this.appendsSinceFlush = 0
      await this.persistManifest()
    }
    this.lastError = undefined
  }

  async close(): Promise<void> {
    await this.operation.catch(() => undefined)
    await this.persistManifest()
    this.lastError = undefined
  }

  private async appendInternal(recordingId: string, point: TrackPoint): Promise<void> {
    const target = this.target(recordingId)
    const meta = this.ensureMeta(recordingId)
    let actualSize = 0
    try { actualSize = (await fs.stat(target)).size } catch { actualSize = 0 }
    if (this.knownSize.get(target) !== actualSize) await this.recoverFile(recordingId, meta)
    // Duplicate or retried samples for the same recording are idempotent.
    if (meta.lastSequence !== null && point.sequence <= meta.lastSequence) return
    await fs.appendFile(target, encodeTrackRecord(point), { mode: 0o600 })
    this.knownSize.set(target, (this.knownSize.get(target) ?? HEADER_BYTES) + RECORD_BYTES)
    meta.firstSequence = meta.firstSequence ?? point.sequence
    meta.lastSequence = point.sequence
    meta.points += 1
    meta.startedAt = meta.startedAt ?? point.capturedAt
    meta.lastCapturedAt = point.capturedAt
    this.manifest.currentRecordingId = recordingId
    this.appendsSinceFlush += 1
    if (this.appendsSinceFlush >= MANIFEST_FLUSH_EVERY) {
      this.appendsSinceFlush = 0
      await this.persistManifest()
    }
  }

  private ensureMeta(recordingId: string): ArchiveRecordingMeta {
    let meta = this.recordingMeta(recordingId)
    if (!meta) {
      meta = { id: recordingId, file: archiveFileName(recordingId), firstSequence: null, lastSequence: null, points: 0, startedAt: null, lastCapturedAt: null, endedAt: null, closed: false }
      this.manifest.recordings.push(meta)
    }
    return meta
  }

  // Validate header and truncate any partial tail before appending, so records
  // stay aligned and a duplicate header is never written.
  private async recoverFile(recordingId: string, meta: ArchiveRecordingMeta): Promise<void> {
    const target = this.target(recordingId)
    let size = 0
    try { size = (await fs.stat(target)).size } catch { size = 0 }
    if (size === 0) {
      await fs.appendFile(target, headerBuffer(), { mode: 0o600 })
      this.knownSize.set(target, HEADER_BYTES)
      return
    }
    if (size < HEADER_BYTES) {
      // Partial header: discard it and write a fresh header.
      await fs.truncate(target, 0)
      await fs.appendFile(target, headerBuffer(), { mode: 0o600 })
      this.knownSize.set(target, HEADER_BYTES)
      return
    }
    const header = Buffer.alloc(HEADER_BYTES)
    const readHandle = await fs.open(target, 'r')
    try { await readHandle.read(header, 0, HEADER_BYTES, 0) } finally { await readHandle.close() }
    if (!header.subarray(0, 4).equals(MAGIC) || header.readUInt32LE(4) !== RECORD_BYTES) {
      // Corrupt header: quarantine the file and start a clean one.
      await fs.rename(target, `${target}.corrupt-${this.now()}`).catch(() => undefined)
      await fs.appendFile(target, headerBuffer(), { mode: 0o600 })
      this.knownSize.set(target, HEADER_BYTES)
      return
    }
    const remainder = (size - HEADER_BYTES) % RECORD_BYTES
    const alignedSize = size - remainder
    if (remainder !== 0) {
      const truncateHandle = await fs.open(target, 'r+')
      try { await truncateHandle.truncate(alignedSize) } finally { await truncateHandle.close() }
    }
    const count = recordCount(alignedSize)
    if (count > 0 && meta.firstSequence === null) {
      const read = await fs.open(target, 'r')
      try {
        const first = Buffer.alloc(RECORD_BYTES)
        const last = Buffer.alloc(RECORD_BYTES)
        await read.read(first, 0, RECORD_BYTES, HEADER_BYTES)
        await read.read(last, 0, RECORD_BYTES, HEADER_BYTES + (count - 1) * RECORD_BYTES)
        const firstPoint = decodeTrackRecord(first)
        const lastPoint = decodeTrackRecord(last)
        if (validPoint(firstPoint) && validPoint(lastPoint)) {
          meta.firstSequence = firstPoint.sequence
          meta.lastSequence = lastPoint.sequence
          meta.startedAt = firstPoint.capturedAt
          meta.lastCapturedAt = lastPoint.capturedAt
        }
      } finally { await read.close() }
    }
    meta.points = count
    this.knownSize.set(target, alignedSize)
  }

  private async readManifest(): Promise<ArchiveManifest | null> {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.directory, MANIFEST_FILE), 'utf8')) as ArchiveManifest
      if (value.version !== 1 || !Array.isArray(value.recordings)) return null
      return value
    } catch { return null }
  }

  // Discoverability cannot depend on the manifest surviving: rebuild it from the
  // bounded first/last record of each archive file when it is missing/corrupt.
  private async rebuildManifest(): Promise<void> {
    let names: string[]
    try { names = (await fs.readdir(this.directory)).filter((name) => name.endsWith('.wlt')) }
    catch { names = [] }
    const recordings: ArchiveRecordingMeta[] = []
    for (const name of names) {
      const target = path.join(this.directory, name)
      try {
        const stat = await fs.stat(target)
        const handle = await fs.open(target, 'r')
        try {
          if (stat.size < HEADER_BYTES) { continue }
          const header = Buffer.alloc(HEADER_BYTES)
          await handle.read(header, 0, HEADER_BYTES, 0)
          if (!header.subarray(0, 4).equals(MAGIC)) continue
          const count = recordCount(stat.size)
          if (count <= 0) continue
          const first = Buffer.alloc(RECORD_BYTES)
          const last = Buffer.alloc(RECORD_BYTES)
          await handle.read(first, 0, RECORD_BYTES, HEADER_BYTES)
          await handle.read(last, 0, RECORD_BYTES, HEADER_BYTES + (count - 1) * RECORD_BYTES)
          const firstPoint = decodeTrackRecord(first)
          const lastPoint = decodeTrackRecord(last)
          if (!validPoint(firstPoint) || !validPoint(lastPoint)) continue
          recordings.push({
            // The file name is `<sha256(id)[0:16]>-<sanitised id>.wlt`; the id is
            // recovered from the suffix (exact for UUID recording identities).
            id: name.replace(/\.wlt$/, '').replace(/^[0-9a-f]{16}-/, ''),
            file: name, firstSequence: firstPoint.sequence, lastSequence: lastPoint.sequence,
            points: count, startedAt: firstPoint.capturedAt, lastCapturedAt: lastPoint.capturedAt,
            endedAt: null, closed: true
          })
        } finally { await handle.close() }
      } catch { /* Skip unreadable files. */ }
    }
    recordings.sort((a, b) => (a.lastCapturedAt ?? 0) - (b.lastCapturedAt ?? 0))
    this.manifest = { version: 1, currentRecordingId: recordings.length ? recordings[recordings.length - 1]!.id : null, recordings }
    await this.persistManifest()
  }

  private async persistManifest(): Promise<void> {
    const target = path.join(this.directory, MANIFEST_FILE)
    const temporary = `${target}.tmp`
    const handle = await fs.open(temporary, 'w', 0o600)
    try { await handle.writeFile(`${JSON.stringify(this.manifest)}\n`); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, target)
    if (process.platform !== 'win32') {
      const directory = await fs.open(this.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }

  private target(recordingId: string): string {
    return path.join(this.directory, archiveFileName(recordingId))
  }
}
