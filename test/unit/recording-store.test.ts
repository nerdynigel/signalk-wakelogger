import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordingStore } from '../../src/trips/recording-store'
import type { TelemetryDraft } from '../../src/telemetry/types'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recordings-'))
  directories.push(directory)
  const target = path.join(directory, 'state.json')
  const store = new RecordingStore(target)
  await store.open()
  return { store, target }
}
function sample(at: number, speed = 4): TelemetryDraft {
  return { capturedAt: at, receivedAt: at, values: { lat: -27, lon: 153, sog_kn: speed }, quality: { timestamp: 'source' } }
}

describe('durable recordings', () => {
  it('includes departure candidates, survives restart and closes a contiguous range including stop evidence', async () => {
    const { store, target } = await fixture()
    const first = sample(1000)
    await store.prepare(first, 11)
    expect(first.recording).toMatchObject({ firstSequence: 11, startedAt: 1000, state: 'recording' })
    const resumed = new RecordingStore(target)
    await resumed.open()
    const moving = sample(121000)
    await resumed.prepare(moving, 12)
    expect(moving.trackingSessionId).toBe(first.trackingSessionId)
    await resumed.prepare(sample(122000, 0), 13)
    const stopped = sample(1022000, 0)
    await resumed.prepare(stopped, 14)
    expect(stopped.recording).toEqual({ ...first.recording, state: 'complete', endedAt: 122000, lastSequence: 14 })
    const closedRestart = new RecordingStore(target)
    await closedRestart.open()
    expect(closedRestart.manifests()).toEqual([stopped.recording])
  })

  it('closes a cancelled departure and gives the next candidate a different ID', async () => {
    const { store } = await fixture()
    const first = sample(1000)
    await store.prepare(first, 1)
    const cancel = sample(2000, 0)
    await store.prepare(cancel, 2)
    expect(cancel.recording).toMatchObject({ id: first.recording?.id, state: 'cancelled', lastSequence: 2 })
    const next = sample(3000)
    await store.prepare(next, 3)
    expect(next.recording?.id).not.toBe(first.recording?.id)
  })

  it('marks a long recording interruption incomplete instead of bridging separate outings', async () => {
    const { store, target } = await fixture()
    await store.prepare(sample(1000), 1)
    await store.prepare(sample(121000), 2)
    const resumed = new RecordingStore(target)
    await resumed.open()
    await resumed.prepare(sample(4_000_000), 3)
    expect(resumed.manifests()).toEqual([
      expect.objectContaining({ state: 'interrupted', firstSequence: 1, lastSequence: 2, endedAt: 121000 }),
      expect.objectContaining({ state: 'recording', firstSequence: 3 })
    ])
  })

  it('preserves raw backward timestamps without cancelling or fragmenting a recording', async () => {
    const { store, target } = await fixture()
    const first = sample(1_800_000_000_000)
    await store.prepare(first, 1)
    const old = sample(1_400_000_000_000, 0)
    await store.prepare(old, 2)
    expect(old.capturedAt).toBe(1_400_000_000_000)
    expect(old.recording).toEqual(first.recording)
    const resumed = new RecordingStore(target)
    await resumed.open()
    const current = sample(first.capturedAt + 120_000)
    await resumed.prepare(current, 3)
    expect(current.trackingSessionId).toBe(first.trackingSessionId)
    expect(resumed.currentState().state).toBe('MOVING')
    expect(resumed.manifests()).toHaveLength(1)
    await resumed.prepare(sample(first.capturedAt + 4_000_000), 4)
    expect(resumed.manifests()[0]).toMatchObject({ state: 'interrupted', endedAt: current.capturedAt, lastSequence: 3 })
  })

  it('discards legacy stop evidence from before the recording instead of inventing an end time', async () => {
    const { store, target } = await fixture()
    const first = sample(1_800_000_000_000)
    await store.prepare(first, 1)
    const saved = JSON.parse(await fs.readFile(target, 'utf8'))
    saved.trip = { state: 'STOP_CANDIDATE', trackingSessionId: first.trackingSessionId, candidateAt: 1_400_000_000_000, candidatePosition: { lat: -27, lon: 153 } }
    saved.lastCapturedAt = 1_400_000_000_000
    await fs.writeFile(target, JSON.stringify(saved))
    const resumed = new RecordingStore(target)
    await resumed.open()
    await resumed.prepare(sample(first.capturedAt + 120_000, 0), 2)
    expect(resumed.currentState()).toMatchObject({ state: 'STOP_CANDIDATE', candidateAt: first.capturedAt + 120_000 })
    expect(resumed.manifests()).toEqual([first.recording])
  })

  it('rotates bounded status pages and only prunes exact durable manifest acknowledgements', async () => {
    const { store, target } = await fixture()
    for (let index = 0; index < 25; index += 1) {
      await store.prepare(sample(index * 2000 + 1000), index * 2 + 1)
      await store.prepare(sample(index * 2000 + 2000, 0), index * 2 + 2)
    }
    const first = store.statusManifests()
    const second = store.statusManifests()
    expect(first).toHaveLength(20)
    expect(new Set([...first, ...second].map((manifest) => manifest.id)).size).toBe(25)
    const manifest = first[0]!
    await store.acknowledge([{ ...manifest, lastSequence: 999 }])
    expect(store.manifests()).toHaveLength(25)
    await store.acknowledge([manifest])
    const resumed = new RecordingStore(target)
    await resumed.open()
    expect(resumed.manifests()).toHaveLength(24)
    expect(resumed.manifests().some((entry) => entry.id === manifest.id)).toBe(false)
  })

  it('drops stale closed manifests whose end precedes the recording start', async () => {
    const { target } = await fixture()
    const stale = {
      id: '3b12567a-e28a-4fe3-bcf2-dcee766a434f', startedAt: 1_800_000_000_000, firstSequence: 10,
      state: 'interrupted', endedAt: 1_400_000_000_000, lastSequence: 12
    }
    await fs.writeFile(target, JSON.stringify({ version: 1, trip: { state: 'STOPPED' }, closed: [stale] }))
    const reopened = new RecordingStore(target)
    await reopened.open()
    expect(reopened.manifests()).toEqual([])
    expect(JSON.parse(await fs.readFile(target, 'utf8')).closed).toEqual([])
  })

  it('refuses a corrupt checkpoint instead of silently resetting recording identity', async () => {
    const { target } = await fixture()
    await fs.writeFile(target, '{')
    await expect(new RecordingStore(target).open()).rejects.toThrow()
  })
})

describe('explicit trip finish', () => {
  async function append(store: RecordingStore, at: number, sequence: number) {
    const draft = sample(at)
    await store.prepare(draft, sequence)
    await store.committed({ ...draft, v: 1, deviceId: 'dev_finish', sequence })
    return draft
  }
  it('uses committed bounds, survives restart and retains metadata until the exact receipt ACK', async () => {
    const { store, target } = await fixture()
    const first = await append(store, 1000, 11)
    await append(store, 121000, 12)
    const manifest = await store.finish(first.trackingSessionId!)
    expect(manifest).toMatchObject({ id: first.trackingSessionId, state: 'complete', firstSequence: 11, lastSequence: 12, endedAt: 121000 })
    const resumed = new RecordingStore(target); await resumed.open()
    expect(resumed.currentState().state).toBe('STOPPED')
    expect(await resumed.finish(first.trackingSessionId!)).toEqual(manifest)
    await resumed.acknowledge([{ id: manifest!.id, state: 'complete', lastSequence: 13 }])
    expect(resumed.finishedStatus()?.uploadPending).toBe(true)
    await resumed.acknowledge([{ id: manifest!.id, state: 'complete', lastSequence: 12 }])
    expect(resumed.manifests()).toEqual([])
    expect(resumed.finishedStatus()?.uploadPending).toBe(false)
    expect(await resumed.finish(manifest!.id)).toEqual(manifest)
  })
  it('does not restart on cached navigation, allows new movement and rejects a stale finish request', async () => {
    const { store, target } = await fixture()
    const first = await append(store, 1000, 1)
    await store.finish(first.trackingSessionId!)
    const resumed = new RecordingStore(target); await resumed.open()
    const cached = sample(1000)
    await resumed.prepare(cached, 2)
    expect(cached.trackingSessionId).toBeUndefined()
    expect(resumed.currentState().state).toBe('STOPPED')
    const next = await append(resumed, 2000, 3)
    expect(next.trackingSessionId).not.toBe(first.trackingSessionId)
    await expect(resumed.finish(first.trackingSessionId!)).rejects.toThrow('recording_changed')
    expect(resumed.currentState().trackingSessionId).toBe(next.trackingSessionId)
  })
  it('refuses to close uncommitted departure and leaves no-active retries harmless', async () => {
    const { store } = await fixture()
    expect(await store.finish('00000000-0000-0000-0000-000000000001')).toBeNull()
    const first = sample(1000); await store.prepare(first, 1)
    await expect(store.finish(first.trackingSessionId!)).rejects.toThrow('recording_not_committed')
    expect(store.manifests()[0]?.state).toBe('recording')
    await store.committed({ ...first, v: 1, deviceId: 'dev_finish', sequence: 1 })
    await expect(store.finish(first.trackingSessionId!, 2)).rejects.toThrow('recording_not_committed')
    await store.prepare(sample(2000), 2)
    await expect(store.finish(first.trackingSessionId!, 1)).rejects.toThrow('recording_not_committed')
  })
  it('leaves the active checkpoint intact if finish persistence fails', async () => {
    const { store, target } = await fixture()
    const first = await append(store, 1000, 1)
    await fs.mkdir(`${target}.tmp`)
    await expect(store.finish(first.trackingSessionId!)).rejects.toThrow()
    expect(store.currentState().trackingSessionId).toBe(first.trackingSessionId)
    await fs.rm(`${target}.tmp`, { recursive: true })
    expect((await store.finish(first.trackingSessionId!))?.state).toBe('complete')
  })
})

it('preserves a completed automatic stop when it wins the explicit finish race', async () => {
  const { store } = await fixture()
  const first = sample(1000); await store.prepare(first, 1)
  await store.committed({ ...first, v: 1, deviceId: 'dev_finish', sequence: 1 })
  await store.prepare(sample(121000), 2)
  await store.prepare(sample(122000, 0), 3)
  const last = sample(1022000, 0); await store.prepare(last, 4)
  expect(await store.finish(first.trackingSessionId!)).toEqual(last.recording)
  expect(store.manifests()).toHaveLength(1)
})

it('retries terminal metadata after receipt ACK until exact cloud ready confirmation and preserves it across restart', async () => {
  const { store, target } = await fixture()
  const draft = sample(1000); await store.prepare(draft, 11)
  await store.committed({ ...draft, v: 1, deviceId: 'dev_finish', sequence: 11 })
  const finished = (await store.finish(draft.trackingSessionId!, 11))!
  await store.acknowledge([{ id: finished.id, state: 'complete', lastSequence: 11 }])
  expect(store.finishedStatus()).toMatchObject({ uploadPending: false, confirmationPending: true, cloudStatus: null })
  expect(store.statusManifests()).toContainEqual(finished)
  const cloud = { id: finished.id, lastSequence: 11, state: 'processing' as const, voyageId: 75, expectedSamples: 1, receivedSamples: 1, missingSamples: 0, rejectedSamples: 0 }
  await store.confirm([cloud])
  const resumed = new RecordingStore(target); await resumed.open()
  expect(resumed.finishedStatus()?.cloudStatus?.state).toBe('processing')
  expect(resumed.statusManifests()).toContainEqual(finished)
  await resumed.confirm([{ ...cloud, state: 'ready', lastSequence: 12 }])
  await resumed.confirm([{ ...cloud, state: 'ready', rejectedSamples: 1 }])
  expect(resumed.finishedStatus()?.confirmationPending).toBe(true)
  await resumed.confirm([{ ...cloud, state: 'ready' }])
  expect(resumed.finishedStatus()).toMatchObject({ confirmationPending: false, cloudStatus: { state: 'ready', voyageId: 75 } })
  expect(resumed.statusManifests()).not.toContainEqual(finished)
  const readyRestart = new RecordingStore(target); await readyRestart.open()
  expect(readyRestart.finishedStatus()?.confirmationPending).toBe(false)
})
it('prioritizes pending confirmation ahead of older metadata-only manifests in every status page', async () => {
  const { store } = await fixture()
  for (let index = 0; index < 22; index += 1) {
    await store.prepare(sample(index * 2000 + 1000), index * 2 + 1)
    await store.prepare(sample(index * 2000 + 1500, 0), index * 2 + 2)
  }
  const draft = sample(50000); await store.prepare(draft, 45)
  await store.committed({ ...draft, v: 1, deviceId: 'dev_finish', sequence: 45 })
  const finished = (await store.finish(draft.trackingSessionId!, 45))!
  await store.acknowledge([{ id: finished.id, state: 'complete', lastSequence: 45 }])
  for (let index = 0; index < 3; index += 1) expect(store.statusManifests()[0]).toEqual(finished)
})
