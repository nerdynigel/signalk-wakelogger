import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RacePackStore } from '../../src/race/race-pack-store'
import {
  RacePackReceiver,
  RACE_PACK_LIMITS,
  decodeRacePack,
  parseRacePackChunk,
  parseRacePackManifest,
  type RacePackAck,
  type RacePackManifest
} from '../../src/race/race-pack-protocol'
import { encodeFixturePack, makeFixturePack } from '../helpers/race-pack'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function ackApplied(ack: RacePackAck | null): boolean { return ack?.status === 'applied' }

async function acceptManifest(receiver: RacePackReceiver, encoded: ReturnType<typeof encodeFixturePack>): Promise<RacePackAck | null> {
  return receiver.acceptManifest(encoded.manifestPayload)
}

async function acceptAllChunks(receiver: RacePackReceiver, encoded: ReturnType<typeof encodeFixturePack>): Promise<RacePackAck | null> {
  let ack: RacePackAck | null = null
  for (const [index, payload] of encoded.chunkPayloads.entries()) ack = await receiver.acceptChunk(payload, index)
  return ack
}

async function applyEncoded(receiver: RacePackReceiver, encoded: ReturnType<typeof encodeFixturePack>): Promise<RacePackAck | null> {
  await acceptManifest(receiver, encoded)
  return acceptAllChunks(receiver, encoded)
}

describe('Race Pack protocol and storage', () => {
  it('assembles a retained manifest and out-of-order chunks into a validated pack', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const receiver = new RacePackReceiver({ store })
    const encoded = encodeFixturePack(makeFixturePack(), { chunkCount: 3 })

    // Chunks may arrive before the manifest, and out of order.
    for (const index of [2, 0, 1]) {
      const ack = await receiver.acceptChunk(encoded.chunkPayloads[index]!, index)
      expect(ack).toBeNull()
    }
    const ack = await receiver.acceptManifest(encoded.manifestPayload)
    expect(ackApplied(ack)).toBe(true)
    expect(store.applied()).toMatchObject({ packId: 'pack-42-1', revision: 4, sha256: encoded.sha256, courseId: 'race-42', racePlanId: 42 })
    expect(store.current()?.course.points).toHaveLength(3)
  })

  it('keeps duplicate chunks and duplicate manifests idempotent', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const apply = vi.spyOn(store, 'apply')
    const receiver = new RacePackReceiver({ store })
    const encoded = encodeFixturePack(makeFixturePack(), { chunkCount: 2 })
    for (const [index, payload] of encoded.chunkPayloads.entries()) await receiver.acceptChunk(payload, index)
    expect(ackApplied(await receiver.acceptManifest(encoded.manifestPayload))).toBe(true)
    await receiver.acceptChunk(encoded.chunkPayloads[0]!, 0)
    expect(ackApplied(await receiver.acceptManifest(encoded.manifestPayload))).toBe(true)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('does not replace the current pack when a newer pack is incomplete', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const receiver = new RacePackReceiver({ store })
    const first = encodeFixturePack(makeFixturePack(), { chunkCount: 2 })
    await applyEncoded(receiver, first)

    const newer = encodeFixturePack(makeFixturePack({ packId: 'pack-42-2', revision: 5 }), { chunkCount: 3 })
    await receiver.acceptManifest(newer.manifestPayload)
    await receiver.acceptChunk(newer.chunkPayloads[0]!, 0)
    await receiver.acceptChunk(newer.chunkPayloads[1]!, 1)
    expect(store.applied()?.revision).toBe(4)
    expect(store.current()?.packId).toBe('pack-42-1')
  })

  it('rejects invalid base64, oversized packs and wrong digests without losing the applied pack', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const receiver = new RacePackReceiver({ store })
    const good = encodeFixturePack(makeFixturePack(), { chunkCount: 2 })
    await applyEncoded(receiver, good)

    expect(() => parseRacePackChunk(Buffer.from(JSON.stringify({ v: 1, packId: 'p', revision: 9, index: 0, chunkCount: 1, data: 'not base64!' })))).toThrow(/chunk_base64_invalid/)
    expect(() => parseRacePackChunk(Buffer.from(JSON.stringify({ v: 1, packId: 'p', revision: 9, index: 5, chunkCount: 2, data: 'AAAA' })))).toThrow(/chunk_index_invalid/)
    expect(() => parseRacePackChunk(Buffer.from(JSON.stringify({ v: 1, packId: 'p', revision: 9, index: 0, chunkCount: 1, data: 'A'.repeat(RACE_PACK_LIMITS.maxChunkChars + 4) })))).toThrow(/chunk_base64_invalid/)
    expect(() => parseRacePackChunk(Buffer.alloc(RACE_PACK_LIMITS.maxChunkMessageBytes + 1, 32))).toThrow(/chunk_invalid/)

    const badBase64 = Buffer.from(JSON.stringify({ v: 1, packId: 'pack-42-2', revision: 5, index: 0, chunkCount: 1, data: '####' }))
    const badChunkAck = await receiver.acceptChunk(badBase64, 0)
    expect(badChunkAck).toMatchObject({ status: 'rejected', errorCode: 'chunk_base64_invalid' })

    // A gzip stream that decompresses to more than the uncompressed ceiling.
    const huge = Buffer.from(JSON.stringify({ ...makeFixturePack({ packId: 'pack-bomb', revision: 6 }), firehose: 'x'.repeat(RACE_PACK_LIMITS.maxUncompressedBytes + 1024) }))
    const compressed = gzipSync(huge).toString('base64')
    const bombManifest = Buffer.from(JSON.stringify({ v: 1, packId: 'pack-bomb', revision: 6, racePlanId: null, generatedAt: '2026-09-17T01:00:00Z', validFrom: null, validUntil: null, ruleSetVersion: 'race_plan_dynamic_v1', encoding: 'gzip+base64', chunkCount: 1, sha256: createHash('sha256').update(huge).digest('hex') }))
    await receiver.acceptManifest(bombManifest)
    const bombAck = await receiver.acceptChunk(Buffer.from(JSON.stringify({ v: 1, packId: 'pack-bomb', revision: 6, index: 0, chunkCount: 1, data: compressed })), 0)
    expect(bombAck).toMatchObject({ status: 'rejected', errorCode: 'pack_too_large' })

    // A wrong digest must be rejected before JSON parsing.
    const wrongDigest = Buffer.from(JSON.stringify({ ...(good.manifest as unknown as Record<string, unknown>), packId: 'pack-wrong', revision: 7, chunkCount: 1, sha256: 'f'.repeat(64) }))
    await receiver.acceptManifest(wrongDigest)
    const wrongAck = await receiver.acceptChunk(Buffer.from(JSON.stringify({ v: 1, packId: 'pack-wrong', revision: 7, index: 0, chunkCount: 1, data: good.chunkPayloads.map((payload) => (JSON.parse(payload.toString()) as { data: string }).data).join('') })), 0)
    expect(wrongAck).toMatchObject({ status: 'rejected', errorCode: 'pack_digest_mismatch' })
    expect(store.applied()?.revision).toBe(4)
  })

  it('rejects a chunk whose topic index does not match its payload index', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const receiver = new RacePackReceiver({ store })
    const encoded = encodeFixturePack(makeFixturePack({ packId: 'pack-index', revision: 8 }), { chunkCount: 2 })
    await receiver.acceptManifest(encoded.manifestPayload)
    const mismatch = await receiver.acceptChunk(encoded.chunkPayloads[0]!, 1)
    expect(mismatch).toMatchObject({ status: 'rejected', errorCode: 'chunk_topic_index_mismatch' })
    // The mismatch must not contribute a chunk, so the pack cannot complete.
    expect(store.applied()).toBeNull()
    // Sending the same chunk on the correct topic still cannot complete alone.
    await receiver.acceptChunk(encoded.chunkPayloads[0]!, 0)
    expect(store.applied()).toBeNull()
    // Completing correctly applies normally.
    expect(ackApplied(await receiver.acceptChunk(encoded.chunkPayloads[1]!, 1))).toBe(true)
    expect(store.applied()?.revision).toBe(8)
  })

  it('rejects unsupported rule sets before applying and preserves the current pack', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const receiver = new RacePackReceiver({ store })
    const good = encodeFixturePack(makeFixturePack(), { chunkCount: 1 })
    await applyEncoded(receiver, good)

    expect(() => parseRacePackManifest(Buffer.from(JSON.stringify({ ...(good.manifest as Record<string, unknown>), ruleSetVersion: 'race_plan_preview_v1' })))).toThrow(/unsupported_rule_set/)
    const rejected = await receiver.acceptManifest(Buffer.from(JSON.stringify({ ...(good.manifest as Record<string, unknown>), packId: 'pack-rules', revision: 5, ruleSetVersion: 'race_plan_preview_v1' })))
    expect(rejected).toMatchObject({ status: 'rejected', errorCode: 'unsupported_rule_set' })
    expect(store.applied()).toMatchObject({ packId: 'pack-42-1', revision: 4 })
  })

  it('rejects identity mismatches and stale revisions without rolling back', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const receiver = new RacePackReceiver({ store })
    const good = encodeFixturePack(makeFixturePack(), { chunkCount: 2 })
    await applyEncoded(receiver, good)
    expect(store.applied()?.revision).toBe(4)

    // Manifest revision 5 but the embedded pack is revision 4.
    const mismatch = encodeFixturePack(makeFixturePack({ packId: 'pack-42-9', revision: 4 }), { chunkCount: 2, revision: 5 })
    await receiver.acceptManifest(mismatch.manifestPayload)
    const mismatchAck = await acceptAllChunks(receiver, mismatch)
    expect(mismatchAck).toMatchObject({ status: 'rejected', errorCode: 'pack_identity_mismatch' })

    // A genuinely older revision cannot roll back.
    const stale = encodeFixturePack(makeFixturePack({ packId: 'pack-old', revision: 2 }), { chunkCount: 2 })
    const staleAck = await receiver.acceptManifest(stale.manifestPayload)
    expect(staleAck).toMatchObject({ status: 'rejected', errorCode: 'stale_revision' })
    expect(store.applied()).toMatchObject({ packId: 'pack-42-1', revision: 4 })
  })

  it('applies a higher revision of the same pack id as a normal update', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const receiver = new RacePackReceiver({ store })
    const first = encodeFixturePack(makeFixturePack(), { chunkCount: 2 })
    await applyEncoded(receiver, first)

    const update = encodeFixturePack(makeFixturePack({ revision: 5, payload: { startTime: '2026-09-17T03:00:00Z', availableCrewCount: 2 } }), { chunkCount: 2 })
    await receiver.acceptManifest(update.manifestPayload)
    const ack = await acceptAllChunks(receiver, update)
    expect(ackApplied(ack)).toBe(true)
    expect(store.applied()?.revision).toBe(5)
    expect(store.current()?.payload.availableCrewCount).toBe(2)
  })

  it('persists a successful pack across a store restart and can re-advertise its ACK', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const receiver = new RacePackReceiver({ store, now: () => Date.parse('2026-09-17T02:00:00Z') })
    const encoded = encodeFixturePack(makeFixturePack(), { chunkCount: 2 })
    await applyEncoded(receiver, encoded)
    expect(await fs.readdir(directory)).toContain('current.json')

    const reopened = new RacePackStore(directory)
    await reopened.open()
    expect(reopened.applied()).toMatchObject({ packId: 'pack-42-1', revision: 4, sha256: encoded.sha256 })
    const restartedReceiver = new RacePackReceiver({ store: reopened })
    expect(restartedReceiver.currentAck()).toMatchObject({ status: 'applied', packId: 'pack-42-1', revision: 4 })
  })

  it('ACKs only after the pack has been durably applied', async () => {
    let release: (() => void) | undefined
    const applied = vi.fn()
    const store = {
      applied: () => (applied.mock.calls.length ? { packId: 'pack-deferred', revision: 1, sha256: 'a'.repeat(64), ruleSetVersion: 'race_plan_dynamic_v1', courseId: 'race', racePlanId: null, courseDefinitionDigest: 'b'.repeat(64), generatedAt: '2026-09-17T01:00:00Z', validFrom: null, validUntil: null, appliedAt: 1 } : null),
      apply: vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve }); applied(); return true })
    }
    const receiver = new RacePackReceiver({ store })
    const encoded = encodeFixturePack(makeFixturePack({ packId: 'pack-deferred', revision: 1 }), { chunkCount: 1 })
    await receiver.acceptManifest(encoded.manifestPayload)
    const pending = receiver.acceptChunk(encoded.chunkPayloads[0]!, 0)
    await Promise.resolve()
    expect(release).toBeTypeOf('function')
    expect(store.apply).toHaveBeenCalledTimes(1)
    release!()
    expect(ackApplied(await pending)).toBe(true)
  })

  it('survives a corrupt stored pack without crashing', async () => {
    const directory = await temporaryDirectory('race-pack-')
    const store = new RacePackStore(directory)
    const encoded = encodeFixturePack(makeFixturePack(), { chunkCount: 1 })
    await applyEncoded(new RacePackReceiver({ store }), encoded)
    await fs.writeFile(path.join(directory, 'current.json'), '{ not json')
    const reopened = new RacePackStore(directory)
    await expect(reopened.open()).resolves.toBeUndefined()
    expect(reopened.applied()).toBeNull()
  })

  it('validates manifest bounds and rejects unsupported versions', () => {
    const encoded = encodeFixturePack(makeFixturePack(), { chunkCount: 1 })
    expect(parseRacePackManifest(encoded.manifestPayload).chunkCount).toBe(1)
    expect(() => parseRacePackManifest(Buffer.from(JSON.stringify({ ...(encoded.manifest as Record<string, unknown>), v: 2 })))).toThrow(/manifest_unsupported_version/)
    expect(() => parseRacePackManifest(Buffer.from(JSON.stringify({ ...(encoded.manifest as Record<string, unknown>), encoding: 'plain' })))).toThrow(/encoding_unsupported/)
    expect(() => parseRacePackManifest(Buffer.from(JSON.stringify({ ...(encoded.manifest as Record<string, unknown>), chunkCount: RACE_PACK_LIMITS.maxChunks + 1 })))).toThrow(/chunk_count_invalid/)
  })

  it('assembles deterministically for identical inputs', async () => {
    const encoded = encodeFixturePack(makeFixturePack(), { chunkCount: 2 })
    const chunks = new Map(encoded.chunkPayloads.map((payload, index) => [index, (JSON.parse(payload.toString()) as { data: string }).data]))
    const first = decodeRacePack(encoded.manifest as unknown as RacePackManifest, chunks)
    const second = decodeRacePack(encoded.manifest as unknown as RacePackManifest, chunks)
    expect(first.bytes.equals(second.bytes)).toBe(true)
    expect(first.pack).toEqual(second.pack)
  })
})
