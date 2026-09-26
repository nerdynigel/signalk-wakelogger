import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OnboardSnapshotStore, type OnboardPlanSnapshot } from '../../src/race/onboard-store'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

function snapshot(id: string): OnboardPlanSnapshot {
  return {
    v: 1, kind: 'race_plan_snapshot', id, generatedAt: Date.parse('2026-09-17T02:00:00Z'), source: 'onboard',
    packId: 'pack-42-1', packRevision: 4, packSha256: 'a'.repeat(64), ruleSetVersion: 'race_plan_dynamic_v1',
    tracking: { courseId: 'race-42', racePlanId: 42, activeIndex: 1, totalPoints: 3, reverse: false },
    observations: { twsKnots: 12, twdDeg: 45, gustKnots: 15, headingDeg: 10, cogDeg: 10, sogKnots: 6, stwKnots: null, heelDeg: null, awsKnots: null, awaDeg: null, sampleCount: 1, windowSeconds: 300, windSource: 'true', qualifyingSampleCount: 1, coveredSeconds: 0, latestSampleAgeSeconds: 0 },
    position: { latitude: -27.4, longitude: 153.17 }, activeLegSequence: 1, completedLegCount: 0,
    estimatedFinishAt: null, remainingDurationSeconds: null, legCount: 1,
    forecastCoverage: 'complete', warning: null,
    plan: { v: 1, generatedAt: '2026-09-17T02:00:00Z', packId: 'pack-42-1', packRevision: 4, ruleSetVersion: 'race_plan_dynamic_v1', courseId: 'race-42', racePlanId: 42, courseDefinitionDigest: null, activeLegSequence: 1, completedLegCount: 0, estimatedFinishAt: null, remainingDurationSeconds: null, forecastCoverage: 'complete', warnings: [], observed: null, legs: [] }
  }
}

describe('onboard snapshot store', () => {
  it('queues unpublished snapshots durably and deduplicates publication', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onboard-store-'))
    directories.push(directory)
    const target = path.join(directory, 'state.json')
    const store = new OnboardSnapshotStore(target)
    await store.open()
    await store.append(snapshot('a'), 1)
    await store.append(snapshot('b'), 2)
    await store.append(snapshot('c'), 3)
    expect(store.pending().map((entry) => entry.sequence)).toEqual([1, 2, 3])
    expect(store.latest()?.id).toBe('c')
    await store.markPublished([1, 2])
    expect(store.pending().map((entry) => entry.sequence)).toEqual([3])
    await store.close()

    const reopened = new OnboardSnapshotStore(target)
    await reopened.open()
    expect(reopened.latest()?.id).toBe('c')
    expect(reopened.pending().map((entry) => entry.sequence)).toEqual([3])
  })

  it('keeps published snapshots durable until application ACK', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onboard-store-'))
    directories.push(directory)
    const target = path.join(directory, 'state.json')
    const store = new OnboardSnapshotStore(target)
    await store.open()
    await store.append(snapshot('a'), 1)
    await store.append(snapshot('b'), 2)
    await store.markPublished([1, 2], 10)
    expect(store.pending()).toEqual([])
    expect(store.unacknowledged().map((entry) => entry.sequence)).toEqual([1, 2])
    expect(store.unacknowledged()[0]).toMatchObject({ state: 'published', attempts: 1, lastAttemptAt: 10, firstPublishedAt: 10 })
    await store.close()

    // Restart before ACK: unacknowledged snapshots survive and retry.
    const reopened = new OnboardSnapshotStore(target)
    await reopened.open()
    expect(reopened.unacknowledged().map((entry) => entry.sequence)).toEqual([1, 2])

    await reopened.markPublished([1, 2], 20)
    expect(reopened.unacknowledged()[0]).toMatchObject({ state: 'published', attempts: 2, lastAttemptAt: 20 })

    // ACK by durable snapshot id; duplicate ACK is harmless.
    expect(await reopened.acknowledge(['a'], 30)).toBe(1)
    expect(await reopened.acknowledge(['a'], 31)).toBe(0)
    expect(reopened.unacknowledged().map((entry) => entry.sequence)).toEqual([2])
    await reopened.close()

    const afterAck = new OnboardSnapshotStore(target)
    await afterAck.open()
    expect(afterAck.unacknowledged().map((entry) => entry.sequence)).toEqual([2])
    expect(afterAck.latest()?.id).toBe('b')
  })

  it('migrates a v1 checkpoint into durable published state', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onboard-store-'))
    directories.push(directory)
    const target = path.join(directory, 'state.json')
    const value = snapshot('legacy')
    await fs.writeFile(target, JSON.stringify({ version: 1, nextSequence: 2, latest: { sequence: 1, at: 5, snapshot: value, published: true }, events: [{ sequence: 1, at: 5, snapshot: value, published: true }] }))
    const store = new OnboardSnapshotStore(target)
    await store.open()
    expect(store.pending()).toEqual([])
    expect(store.unacknowledged().map((entry) => entry.sequence)).toEqual([1])
  })
})
