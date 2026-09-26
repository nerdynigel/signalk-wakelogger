import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { MAX_PACK_BYTES, isSupportedRuleSet, parseRacePack, RacePackError, type RacePack, type RacePackIdentity } from './pack'

// Shared MQTT Race Pack protocol v1. The cloud gzips one canonical JSON race
// pack, base64 encodes it and splits the base64 string into bounded chunks.
// The plugin never trusts the wire: every field is bounded and validated, and
// the SHA-256 is checked against the decompressed bytes before JSON is parsed.
//
// Size constants are in bytes unless the name says Chars. `maxChunkChars` is
// the base64 fragment length (characters) and is divisible by 4; the complete
// serialised MQTT chunk message must stay within `maxChunkMessageBytes`.
export const RACE_PACK_LIMITS = {
  maxManifestBytes: 8 * 1024,
  maxChunkMessageBytes: 64 * 1024,
  maxChunkChars: 48 * 1024,
  maxChunks: 64,
  // Measured realistic stress pack: 209,917 B uncompressed / 17,116 B gzip.
  // Bounds are chosen with headroom for denser forecast windows and longer
  // courses while still bounding decompression work and hostile input.
  maxCompressedBytes: 256 * 1024,
  maxUncompressedBytes: MAX_PACK_BYTES,
  maxPendingPacks: 4
} as const

const PACK_ID = /^[A-Za-z0-9._:-]{1,128}$/
const SHA256 = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export interface RacePackManifest {
  v: 1
  packId: string
  revision: number
  racePlanId: number | null
  generatedAt: string
  validFrom: string | null
  validUntil: string | null
  ruleSetVersion: string
  encoding: 'gzip+base64'
  chunkCount: number
  sha256: string
}

export interface RacePackChunk {
  v: 1
  packId: string
  revision: number
  index: number
  chunkCount: number
  data: string
}

export type RacePackAckStatus = 'applied' | 'rejected'

export interface RacePackAck {
  v: 1
  packId: string
  revision: number
  sha256: string
  status: RacePackAckStatus
  appliedAt: string
  errorCode: string | null
  /** Absent/'apply' for a pack application; 'clear' for a cleared pack. */
  action?: 'apply' | 'clear'
}

// Retained tombstone published on the manifest topic when a Race Plan is
// deselected/archived. Monotonic revision; cannot be older than the applied
// pack and cannot resurrect a newer pack.
export interface RacePackClear {
  v: 1
  action: 'clear'
  revision: number
  generatedAt: string
  reason?: string | null
}

export type RacePackControl = { kind: 'manifest'; manifest: RacePackManifest } | { kind: 'clear'; clear: RacePackClear }

export interface AppliedRacePack extends RacePackIdentity {
  revision: number
  sha256: string
  appliedAt: number
}

export interface RacePackStoreLike {
  applied(): AppliedRacePack | null
  apply(entry: { bytes: Buffer; pack: RacePack; manifest: RacePackManifest; appliedAt: number }): Promise<boolean>
  clear(entry: { clear: RacePackClear; clearedAt: number }): Promise<boolean>
  clearedRevision(): number | null
}

export class RacePackProtocolError extends Error {
  constructor(readonly code: string) { super(code) }
}

function isSafeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= Number.MAX_SAFE_INTEGER
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function readObject(payload: Buffer, maximum: number, code: string): Record<string, unknown> {
  if (!Buffer.isBuffer(payload) || payload.length === 0 || payload.length > maximum) throw new RacePackProtocolError(code)
  let value: unknown
  try { value = JSON.parse(payload.toString('utf8')) } catch { throw new RacePackProtocolError(code) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RacePackProtocolError(code)
  return value as Record<string, unknown>
}

export function parseRacePackManifest(payload: Buffer): RacePackManifest {
  const value = readObject(payload, RACE_PACK_LIMITS.maxManifestBytes, 'manifest_invalid')
  if (value.v !== 1) throw new RacePackProtocolError('manifest_unsupported_version')
  if (typeof value.packId !== 'string' || !PACK_ID.test(value.packId)) throw new RacePackProtocolError('manifest_invalid')
  if (!isSafeRevision(value.revision)) throw new RacePackProtocolError('manifest_invalid')
  if (value.racePlanId != null && !Number.isSafeInteger(value.racePlanId)) throw new RacePackProtocolError('manifest_invalid')
  if (!isDateString(value.generatedAt)) throw new RacePackProtocolError('manifest_invalid')
  for (const field of ['validFrom', 'validUntil'] as const) {
    if (value[field] != null && !isDateString(value[field])) throw new RacePackProtocolError('manifest_invalid')
  }
  if (typeof value.ruleSetVersion !== 'string' || !isSupportedRuleSet(value.ruleSetVersion)) throw new RacePackProtocolError('unsupported_rule_set')
  if (value.encoding !== 'gzip+base64') throw new RacePackProtocolError('encoding_unsupported')
  if (!Number.isSafeInteger(value.chunkCount) || Number(value.chunkCount) < 1 || Number(value.chunkCount) > RACE_PACK_LIMITS.maxChunks) throw new RacePackProtocolError('chunk_count_invalid')
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) throw new RacePackProtocolError('manifest_invalid')
  return {
    v: 1,
    packId: value.packId,
    revision: Number(value.revision),
    racePlanId: value.racePlanId == null ? null : Number(value.racePlanId),
    generatedAt: value.generatedAt,
    validFrom: (value.validFrom as string | null | undefined) ?? null,
    validUntil: (value.validUntil as string | null | undefined) ?? null,
    ruleSetVersion: value.ruleSetVersion,
    encoding: 'gzip+base64',
    chunkCount: Number(value.chunkCount),
    sha256: value.sha256.toLowerCase()
  }
}

export function parseRacePackClear(payload: Buffer): RacePackClear {
  const value = readObject(payload, RACE_PACK_LIMITS.maxManifestBytes, 'clear_invalid')
  if (value.v !== 1 || value.action !== 'clear') throw new RacePackProtocolError('clear_invalid')
  if (!isSafeRevision(value.revision)) throw new RacePackProtocolError('clear_invalid')
  if (!isDateString(value.generatedAt)) throw new RacePackProtocolError('clear_invalid')
  if (value.reason != null && (typeof value.reason !== 'string' || value.reason.length > 120)) throw new RacePackProtocolError('clear_invalid')
  return { v: 1, action: 'clear', revision: Number(value.revision), generatedAt: value.generatedAt, reason: (value.reason as string | null | undefined) ?? null }
}

export function parseRacePackControl(payload: Buffer): RacePackControl {
  let action: unknown
  try { action = (JSON.parse(payload.toString('utf8')) as { action?: unknown })?.action } catch { action = undefined }
  return action === 'clear' ? { kind: 'clear', clear: parseRacePackClear(payload) } : { kind: 'manifest', manifest: parseRacePackManifest(payload) }
}

export function parseRacePackChunk(payload: Buffer): RacePackChunk {
  const value = readObject(payload, RACE_PACK_LIMITS.maxChunkMessageBytes, 'chunk_invalid')
  if (value.v !== 1) throw new RacePackProtocolError('chunk_unsupported_version')
  if (typeof value.packId !== 'string' || !PACK_ID.test(value.packId)) throw new RacePackProtocolError('chunk_invalid')
  if (!isSafeRevision(value.revision)) throw new RacePackProtocolError('chunk_invalid')
  if (!Number.isSafeInteger(value.chunkCount) || Number(value.chunkCount) < 1 || Number(value.chunkCount) > RACE_PACK_LIMITS.maxChunks) throw new RacePackProtocolError('chunk_count_invalid')
  if (!Number.isSafeInteger(value.index) || Number(value.index) < 0 || Number(value.index) >= Number(value.chunkCount)) throw new RacePackProtocolError('chunk_index_invalid')
  if (typeof value.data !== 'string' || value.data.length > RACE_PACK_LIMITS.maxChunkChars || value.data.length % 4 !== 0 || !BASE64.test(value.data)) throw new RacePackProtocolError('chunk_base64_invalid')
  return {
    v: 1,
    packId: value.packId,
    revision: Number(value.revision),
    index: Number(value.index),
    chunkCount: Number(value.chunkCount),
    data: value.data
  }
}

function decodeBase64(data: string): Buffer {
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw new RacePackProtocolError('chunk_base64_invalid')
  const buffer = Buffer.from(data, 'base64')
  if (buffer.toString('base64') !== data) throw new RacePackProtocolError('chunk_base64_invalid')
  return buffer
}

function boundedGunzip(compressed: Buffer): Buffer {
  try {
    return gunzipSync(compressed, { maxOutputLength: RACE_PACK_LIMITS.maxUncompressedBytes + 1 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ERR_BUFFER_TOO_LARGE' || code === 'ERR_OUT_OF_RANGE') throw new RacePackProtocolError('pack_too_large')
    throw new RacePackProtocolError('pack_gzip_invalid')
  }
}

export interface AssembledRacePack {
  bytes: Buffer
  pack: RacePack
}

export function decodeRacePack(manifest: RacePackManifest, chunks: Map<number, string>): AssembledRacePack {
  if (chunks.size !== manifest.chunkCount) throw new RacePackProtocolError('chunk_missing')
  const ordered: string[] = []
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const data = chunks.get(index)
    if (typeof data !== 'string') throw new RacePackProtocolError('chunk_missing')
    ordered.push(data)
  }
  const base64 = ordered.join('')
  if (base64.length > RACE_PACK_LIMITS.maxChunks * RACE_PACK_LIMITS.maxChunkChars) throw new RacePackProtocolError('pack_too_large')
  const estimatedCompressed = Math.floor(base64.length / 4) * 3
  if (estimatedCompressed > RACE_PACK_LIMITS.maxCompressedBytes + 3) throw new RacePackProtocolError('pack_too_large')
  const compressed = decodeBase64(base64)
  if (compressed.length === 0 || compressed.length > RACE_PACK_LIMITS.maxCompressedBytes) throw new RacePackProtocolError('pack_too_large')
  const bytes = boundedGunzip(compressed)
  if (bytes.length === 0 || bytes.length > RACE_PACK_LIMITS.maxUncompressedBytes) throw new RacePackProtocolError('pack_too_large')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== manifest.sha256) throw new RacePackProtocolError('pack_digest_mismatch')
  let pack: RacePack
  try { pack = parseRacePack(bytes) } catch (error) {
    throw new RacePackProtocolError(error instanceof RacePackError ? error.code : 'pack_invalid')
  }
  if (pack.revision !== manifest.revision) throw new RacePackProtocolError('pack_identity_mismatch')
  if (pack.ruleSetVersion !== manifest.ruleSetVersion) throw new RacePackProtocolError('pack_identity_mismatch')
  if (pack.packId != null && pack.packId !== manifest.packId) throw new RacePackProtocolError('pack_identity_mismatch')
  const packPlan = pack.racePlanId ?? pack.course.racePlanId ?? null
  if (manifest.racePlanId != null && packPlan != null && manifest.racePlanId !== packPlan) throw new RacePackProtocolError('pack_identity_mismatch')
  return { bytes, pack }
}

function bestEffortIdentity(payload: Buffer, fallbackCode: string): { packId: string; revision: number; sha256: string; errorCode: string } {
  let packId = 'unknown'
  let revision = 0
  let sha256 = ''
  try {
    const value = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    if (typeof value?.packId === 'string' && PACK_ID.test(value.packId)) packId = value.packId
    if (isSafeRevision(value?.revision)) revision = Number(value.revision)
    if (typeof value?.sha256 === 'string' && SHA256.test(value.sha256)) sha256 = value.sha256.toLowerCase()
  } catch { /* fall through to the bounded default */ }
  return { packId, revision, sha256, errorCode: fallbackCode }
}

export class RacePackReceiver {
  private readonly pending = new Map<string, { manifest?: RacePackManifest; chunks: Map<number, string>; updatedAt: number }>()
  private lastRejected?: RacePackAck
  private readonly now: () => number

  constructor(private readonly options: { store: RacePackStoreLike; now?: () => number; maxPending?: number }) {
    this.now = options.now ?? Date.now
  }

  private key(packId: string, revision: number): string { return `${packId}:${revision}` }

  private ack(status: RacePackAckStatus, identity: { packId: string; revision: number; sha256: string }, errorCode: string | null = null): RacePackAck {
    return { v: 1, packId: identity.packId, revision: identity.revision, sha256: identity.sha256, status, appliedAt: new Date(this.now()).toISOString(), errorCode }
  }

  private reject(payload: Buffer, fallback: string): RacePackAck {
    const identity = bestEffortIdentity(payload, fallback)
    const ack = this.ack('rejected', identity, identity.errorCode)
    this.lastRejected = ack
    return ack
  }

  private appliedAck(): RacePackAck | null {
    const applied = this.options.store.applied()
    if (!applied) return null
    return { v: 1, packId: applied.packId ?? 'unknown', revision: applied.revision, sha256: applied.sha256, status: 'applied', appliedAt: new Date(applied.appliedAt).toISOString(), errorCode: null }
  }

  currentAck(): RacePackAck | null {
    const applied = this.appliedAck()
    if (applied) return applied
    const clearedRevision = this.options.store.clearedRevision()
    if (clearedRevision !== null) return this.clearAck('applied', clearedRevision, null)
    return this.lastRejected ?? null
  }

  lastError(): RacePackAck | undefined { return this.lastRejected }

  private clearAck(status: RacePackAckStatus, revision: number, errorCode: string | null): RacePackAck {
    return { v: 1, action: 'clear', packId: '', revision, sha256: '', status, appliedAt: new Date(this.now()).toISOString(), errorCode }
  }

  private rejectClear(clear: RacePackClear, code: string): RacePackAck {
    const ack = this.clearAck('rejected', clear.revision, code)
    this.lastRejected = ack
    return ack
  }

  private async acceptClear(clear: RacePackClear): Promise<RacePackAck> {
    const applied = this.options.store.applied()
    const clearedRevision = this.options.store.clearedRevision()
    if (applied && clear.revision < applied.revision) return this.rejectClear(clear, 'stale_revision')
    if (clearedRevision !== null && clear.revision < clearedRevision) return this.rejectClear(clear, 'stale_revision')
    // Drop any partial packs: retained chunks/manifests must not resurrect the
    // cleared pack.
    this.pending.clear()
    let durable = false
    try {
      durable = await this.options.store.clear({ clear, clearedAt: this.now() })
    } catch {
      durable = false
    }
    if (!durable) {
      const ack = this.clearAck('rejected', clear.revision, 'clear_apply_failed')
      this.lastRejected = ack
      return ack
    }
    this.lastRejected = undefined
    const ack = this.clearAck('applied', clear.revision, null)
    return ack
  }

  async acceptManifest(payload: Buffer): Promise<RacePackAck | null> {
    let control: RacePackControl
    try { control = parseRacePackControl(payload) } catch (error) {
      if (error instanceof RacePackProtocolError && error.code === 'manifest_unsupported_version') return this.reject(payload, 'manifest_unsupported_version')
      if (error instanceof RacePackProtocolError && error.code === 'encoding_unsupported') return this.reject(payload, 'encoding_unsupported')
      if (error instanceof RacePackProtocolError && error.code === 'unsupported_rule_set') return this.reject(payload, 'unsupported_rule_set')
      if (error instanceof RacePackProtocolError && error.code === 'clear_invalid') return this.reject(payload, 'clear_invalid')
      return this.reject(payload, 'manifest_invalid')
    }
    if (control.kind === 'clear') return this.acceptClear(control.clear)
    const manifest = control.manifest
    const applied = this.options.store.applied()
    const clearedRevision = this.options.store.clearedRevision()
    if (clearedRevision !== null && manifest.revision <= clearedRevision) return this.reject(payload, 'stale_revision')
    if (applied) {
      if (manifest.revision < applied.revision) return this.reject(payload, 'stale_revision')
      if (manifest.revision === applied.revision) {
        if (manifest.packId === applied.packId && manifest.sha256 === applied.sha256) return this.ack('applied', manifest)
        return this.reject(payload, 'revision_conflict')
      }
    }
    const key = this.key(manifest.packId, manifest.revision)
    const pending = this.pending.get(key)
    if (pending?.manifest && pending.manifest.sha256 !== manifest.sha256) {
      // A conflicting manifest for the same pack/revision: discard the stale
      // partial pack rather than mixing chunks from two different payloads.
      pending.manifest = manifest
      pending.chunks.clear()
    } else if (pending) {
      pending.manifest = manifest
    } else {
      this.enforcePendingLimit()
      this.pending.set(key, { manifest, chunks: new Map(), updatedAt: this.now() })
    }
    return this.tryAssemble(manifest)
  }

  async acceptChunk(payload: Buffer, topicIndex: number): Promise<RacePackAck | null> {
    if (!Number.isSafeInteger(topicIndex) || topicIndex < 0 || topicIndex >= RACE_PACK_LIMITS.maxChunks) return this.reject(payload, 'chunk_topic_index_invalid')
    let chunk: RacePackChunk
    try { chunk = parseRacePackChunk(payload) } catch (error) {
      if (error instanceof RacePackProtocolError && (error.code === 'chunk_base64_invalid' || error.code === 'chunk_count_invalid' || error.code === 'chunk_index_invalid')) return this.reject(payload, error.code)
      return this.reject(payload, 'chunk_invalid')
    }
    if (chunk.index !== topicIndex) return this.reject(payload, 'chunk_topic_index_mismatch')
    const applied = this.options.store.applied()
    const clearedRevision = this.options.store.clearedRevision()
    if (clearedRevision !== null && chunk.revision <= clearedRevision) return this.reject(payload, 'stale_revision')
    if (applied) {
      if (chunk.revision < applied.revision) return this.reject(payload, 'stale_revision')
      if (chunk.revision === applied.revision && chunk.packId !== applied.packId) return this.reject(payload, 'revision_conflict')
    }
    const key = this.key(chunk.packId, chunk.revision)
    let pending = this.pending.get(key)
    if (!pending) {
      this.enforcePendingLimit()
      pending = { chunks: new Map(), updatedAt: this.now() }
      this.pending.set(key, pending)
    }
    if (pending.manifest && pending.manifest.chunkCount !== chunk.chunkCount) {
      this.pending.delete(key)
      return this.reject(payload, 'chunk_count_mismatch')
    }
    const existing = pending.chunks.get(chunk.index)
    if (existing !== undefined && existing !== chunk.data) return this.reject(payload, 'chunk_conflict')
    if (existing === undefined) pending.chunks.set(chunk.index, chunk.data)
    pending.updatedAt = this.now()
    // Bounded memory: a hostile sender cannot keep unbounded partial chunks.
    let buffered = 0
    for (const data of pending.chunks.values()) buffered += data.length
    if (buffered > RACE_PACK_LIMITS.maxCompressedBytes * 2) {
      this.pending.delete(key)
      return this.reject(payload, 'pack_too_large')
    }
    const manifest = pending.manifest
    if (!manifest || pending.chunks.size !== manifest.chunkCount) return null
    return this.tryAssemble(manifest)
  }

  private async tryAssemble(manifest: RacePackManifest): Promise<RacePackAck | null> {
    const key = this.key(manifest.packId, manifest.revision)
    const pending = this.pending.get(key)
    if (!pending || !pending.manifest || pending.chunks.size !== manifest.chunkCount) return null
    const applied = this.options.store.applied()
    if (applied && manifest.revision < applied.revision) {
      this.pending.delete(key)
      const ack = this.ack('rejected', manifest, 'stale_revision')
      this.lastRejected = ack
      return ack
    }
    if (applied && manifest.revision === applied.revision && (applied.packId !== manifest.packId || applied.sha256 !== manifest.sha256)) {
      this.pending.delete(key)
      const ack = this.ack('rejected', manifest, 'revision_conflict')
      this.lastRejected = ack
      return ack
    }
    let assembled: AssembledRacePack
    try { assembled = decodeRacePack(manifest, pending.chunks) } catch (error) {
      const code = error instanceof RacePackProtocolError ? error.code : 'pack_invalid'
      this.pending.delete(key)
      const ack = this.ack('rejected', manifest, code)
      this.lastRejected = ack
      return ack
    }
    try {
      const durable = await this.options.store.apply({ bytes: assembled.bytes, pack: assembled.pack, manifest, appliedAt: this.now() })
      this.pending.delete(key)
      if (!durable) {
        const ack = this.ack('rejected', manifest, 'stale_revision')
        this.lastRejected = ack
        return ack
      }
      return this.ack('applied', manifest)
    } catch {
      this.pending.delete(key)
      const ack = this.ack('rejected', manifest, 'pack_apply_failed')
      this.lastRejected = ack
      return ack
    }
  }

  private enforcePendingLimit(): void {
    const limit = this.options.maxPending ?? RACE_PACK_LIMITS.maxPendingPacks
    while (this.pending.size >= limit) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, value] of this.pending) if (value.updatedAt < oldestAt) { oldestAt = value.updatedAt; oldestKey = key }
      if (oldestKey === undefined) break
      this.pending.delete(oldestKey)
    }
  }
}

export function racePackAckMatches(left: RacePackAck, right: RacePackAck): boolean {
  return left.status === right.status && left.packId === right.packId && left.revision === right.revision && left.sha256 === right.sha256
}
