import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordingStore } from '../../src/trips/recording-store'
import type { TelemetryDraft } from '../../src/telemetry/types'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })
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
