import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ObservationCollector, deriveTrueWind } from '../../src/race/observations'
import { OnboardRaceService } from '../../src/race/onboard-service'
import { OnboardSnapshotStore } from '../../src/race/onboard-store'
import { RacePackReceiver } from '../../src/race/race-pack-protocol'
import { RacePackStore } from '../../src/race/race-pack-store'
import { encodeFixturePack, makeFixturePack, FIXTURE_COURSE_DIGEST, type FixturePack } from '../helpers/race-pack'

const NOW = Date.parse('2026-09-17T02:05:00Z')
const KNOTS = 1.9438444924406
const directories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function seedPack(store: RacePackStore, pack: FixturePack = makeFixturePack()): Promise<void> {
  const encoded = encodeFixturePack(pack, { chunkCount: 2 })
  const receiver = new RacePackReceiver({ store })
  await receiver.acceptManifest(encoded.manifestPayload)
  for (const [index, payload] of encoded.chunkPayloads.entries()) await receiver.acceptChunk(payload, index)
  expect(store.applied()).not.toBeNull()
}

function delta(values: Array<{ path: string; value: unknown }>): never {
  return { updates: [{ timestamp: new Date(NOW).toISOString(), values }] } as never
}

function observedWindDelta(): never {
  return delta([
    { path: 'navigation.position', value: { latitude: -27.395, longitude: 153.18 } },
    { path: 'navigation.speedOverGround', value: 6 / KNOTS },
    { path: 'navigation.courseOverGroundTrue', value: 10 * Math.PI / 180 },
    { path: 'navigation.headingTrue', value: 10 * Math.PI / 180 },
    { path: 'environment.wind.speedTrue', value: 14 / KNOTS },
    { path: 'environment.wind.directionTrue', value: 45 * Math.PI / 180 }
  ])
}

async function fixture(options: { pack?: FixturePack; authority?: 'automatic' | 'local_only'; racing?: boolean; cadenceMs?: number; reverse?: boolean; position?: boolean } = {}) {
  const directory = await temporaryDirectory('onboard-service-')
  const clock = { value: NOW }
  const observations = new ObservationCollector(5 * 60 * 1000, () => clock.value)
  primeObservations(observations, clock, 30)
  const packs = new RacePackStore(path.join(directory, 'race-packs'))
  await seedPack(packs, options.pack ?? makeFixturePack())
  const snapshots = new OnboardSnapshotStore(path.join(directory, 'onboard-plans', 'state.json'))
  await snapshots.open()
  const service = new OnboardRaceService({
    packs,
    snapshots,
    observations,
    course: () => ({ courseId: 'race-42', racePlanId: 42, courseDefinitionDigest: FIXTURE_COURSE_DIGEST, activeIndex: 1, totalPoints: 3, reverse: options.reverse ?? false }),
    racing: () => options.racing ?? true,
    now: () => clock.value,
    cadenceMs: options.cadenceMs
  })
  await service.setAuthority(options.authority ?? 'local_only')
  return { directory, clock, observations, packs, snapshots, service }
}

// Ingests `count` fresh wind deltas at spaced times so the collector's 5 s
// throttle does not collapse them into one sample. The default 9 s spacing
// spans a genuine five-minute window rather than a burst.
function primeObservations(observations: ObservationCollector, clock: { value: number }, count: number, base = NOW, intervalMs = 9_000): void {
  for (let index = count - 1; index >= 0; index -= 1) {
    clock.value = base - index * intervalMs
    observations.ingest(observedWindDelta())
  }
  clock.value = base
}

describe('onboard calculation authority', () => {
  it('does not run the scheduled calculator while authority is cloud (automatic)', async () => {
    const { service, snapshots } = await fixture({ authority: 'automatic' })
    expect(service.calculationAuthority).toBe('cloud')
    expect(await service.refresh(false)).toBeNull()
    expect((service.availability() as { reason: string }).reason).toBe('cloud_authority')
    expect(snapshots.latest()).toBeNull()
    service.close()
  })

  it('runs onboard as soon as authority transfers to local-only', async () => {
    const { service, snapshots } = await fixture()
    expect(service.calculationAuthority).toBe('onboard')
    const latest = snapshots.latest()
    expect(latest).not.toBeNull()
    expect(latest).toMatchObject({ source: 'onboard', kind: 'race_plan_snapshot', packRevision: 4, ruleSetVersion: 'race_plan_dynamic_v1' })
    expect(latest!.plan.legs.length).toBeGreaterThan(0)
    expect(latest!.tracking).toMatchObject({ courseId: 'race-42', activeIndex: 1 })
    service.close()
  })

  it('does not transfer authority when MQTT is merely offline', async () => {
    const { service } = await fixture({ authority: 'automatic' })
    // There is no transport in this unit fixture; an outage must not silently
    // promote the plugin because authority follows the Live tracking setting.
    expect((service.availability() as { reason: string }).reason).toBe('cloud_authority')
    service.close()
  })

  it('stops the onboard scheduler when switching back to automatic while preserving pack and history', async () => {
    vi.useFakeTimers()
    const { service, snapshots, clock, observations } = await fixture({ cadenceMs: 60_000 })
    const before = snapshots.pending().length
    expect(before).toBeGreaterThan(0)
    clock.value += 60_000
    observations.ingest(observedWindDelta())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(snapshots.pending().length).toBeGreaterThan(before)
    const history = snapshots.latest()
    await service.setAuthority('automatic')
    expect(service.calculationAuthority).toBe('cloud')
    clock.value += 10 * 60_000
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(snapshots.latest()!.id).toBe(history!.id)
    expect(service.status()).toMatchObject({ calculationAuthority: 'cloud' })
    service.close()
  })

  it('reports why no onboard calculation is available', async () => {
    const { service } = await fixture({ racing: false })
    expect((service.availability() as { reason: string }).reason).toBe('not_racing')
    const status = service.status() as { pack: { available: boolean; applicable: boolean }; reason: string }
    expect(status.pack.available).toBe(true)
    expect(status.pack.applicable).toBe(true)
    expect(status.reason).toBe('not_racing')
    service.close()
  })

  it('fails closed for a reversed native course instead of calculating it forwards', async () => {
    const { service, snapshots } = await fixture({ reverse: true })
    expect((service.availability() as { reason: string }).reason).toBe('reverse_course_unsupported')
    expect(await service.refresh(true)).toBeNull()
    expect(snapshots.latest()).toBeNull()
    expect(service.status()).toMatchObject({ reason: 'reverse_course_unsupported' })
    service.close()
  })

  it('does not plan without a valid current position', async () => {
    const directory = await temporaryDirectory('onboard-noposition-')
    const clock = { value: NOW }
    const observations = new ObservationCollector(5 * 60 * 1000, () => clock.value)
    // Wind history without any position: readiness cannot be established and no
    // position may be fabricated.
    const packs = new RacePackStore(path.join(directory, 'race-packs'))
    await seedPack(packs)
    const snapshots = new OnboardSnapshotStore(path.join(directory, 'onboard-plans', 'state.json'))
    await snapshots.open()
    const service = new OnboardRaceService({
      packs, snapshots, observations,
      course: () => ({ courseId: 'race-42', racePlanId: 42, courseDefinitionDigest: FIXTURE_COURSE_DIGEST, activeIndex: 1, totalPoints: 3, reverse: false }),
      racing: () => true,
      now: () => clock.value
    })
    await service.setAuthority('local_only')
    expect((service.availability() as { reason: string }).reason).toBe('no_current_position')
    expect(snapshots.latest()).toBeNull()
    service.close()
  })
})

describe('onboard observations and calculations', () => {
  it('derives true wind deterministically from apparent wind when true wind is missing', () => {
    const apparentAngle = 31.9 * Math.PI / 180
    const derived = deriveTrueWind({ headingDeg: 0, sogKnots: 6, stwKnots: 6, awaDeg: 31.9, awsKnots: 18.7 })
    expect(derived).not.toBeNull()
    expect(derived!.twsKnots).toBeCloseTo(14, 0)
    expect(derived!.twdDeg).toBeCloseTo(45, 0)
    const collector = new ObservationCollector(5 * 60 * 1000, () => NOW)
    collector.ingest(delta([
      { path: 'navigation.position', value: { latitude: -27.395, longitude: 153.18 } },
      { path: 'navigation.headingTrue', value: 0 },
      { path: 'navigation.speedThroughWater', value: 6 / KNOTS },
      { path: 'environment.wind.speedApparent', value: 18.7 / KNOTS },
      { path: 'environment.wind.angleApparent', value: apparentAngle }
    ]))
    const observations = collector.observations(NOW)
    expect(observations.averages.windSource).toBe('derived')
    expect(observations.averages.twsKnots).toBeCloseTo(14, 0)
  })

  it('keeps calculation safe when optional instruments such as STW and heel are missing', async () => {
    const { observations, service, snapshots } = await fixture({ pack: makeFixturePack() })
    observations.ingest(delta([
      { path: 'navigation.position', value: { latitude: -27.395, longitude: 153.18 } },
      { path: 'navigation.speedOverGround', value: 5 / KNOTS },
      { path: 'navigation.courseOverGroundTrue', value: 1.5 }
    ]))
    await service.refresh(true)
    const latest = snapshots.latest()
    expect(latest).not.toBeNull()
    expect(latest!.observations.stwKnots).toBeNull()
    expect(latest!.observations.heelDeg).toBeNull()
    service.close()
  })

  it('uses the local observation window for the current leg and a forecast for later legs', async () => {
    const { service, snapshots } = await fixture()
    const plan = snapshots.latest()!.plan
    expect(plan.legs[0]!.conditions.source).toBe('observed')
    expect(plan.legs[0]!.conditions.twsKnots).toBeCloseTo(14, 0)
    expect(plan.legs[1]!.conditions.source).toBe('forecast')
    service.close()
  })

  it('falls back to the current-leg forecast until observations are ready, then uses observed', async () => {
    const directory = await temporaryDirectory('onboard-fallback-')
    const clock = { value: NOW }
    const observations = new ObservationCollector(5 * 60 * 1000, () => clock.value)
    // Position and navigation only: no credible fresh wind yet.
    observations.ingest(delta([
      { path: 'navigation.position', value: { latitude: -27.395, longitude: 153.18 } },
      { path: 'navigation.speedOverGround', value: 5 / KNOTS },
      { path: 'navigation.courseOverGroundTrue', value: 0.2 }
    ]))
    const packs = new RacePackStore(path.join(directory, 'race-packs'))
    await seedPack(packs)
    const snapshots = new OnboardSnapshotStore(path.join(directory, 'onboard-plans', 'state.json'))
    await snapshots.open()
    const service = new OnboardRaceService({
      packs, snapshots, observations,
      course: () => ({ courseId: 'race-42', racePlanId: 42, courseDefinitionDigest: FIXTURE_COURSE_DIGEST, activeIndex: 1, totalPoints: 3, reverse: false }),
      racing: () => true,
      now: () => clock.value
    })
    await service.setAuthority('local_only')
    const fallback = snapshots.latest()!
    expect(fallback.plan.legs[0]!.conditions.source).toBe('forecast')
    expect(fallback.warning).toMatch(/Fresh onboard observations not yet available/)
    expect(fallback.plan.legs[1]!.conditions.source).toBe('forecast')
    expect(fallback.observations.twsKnots).toBeNull()

    // The rolling window now accumulates a complete wind observation set.
    clock.value = NOW + 300_000
    primeObservations(observations, clock, 30, clock.value)
    await service.refresh(true)
    const observed = snapshots.latest()!
    expect(observed.plan.legs[0]!.conditions.source).toBe('observed')
    expect(observed.plan.legs[0]!.conditions.twsKnots).toBeCloseTo(14, 0)
    expect(observed.plan.legs[1]!.conditions.source).toBe('forecast')
    expect(observed.warning).toBeNull()
    service.close()
  })

  it('works fully offline from a persisted pack and survives a store restart', async () => {
    const directory = await temporaryDirectory('onboard-offline-')
    const packDirectory = path.join(directory, 'race-packs')
    const first = new RacePackStore(packDirectory)
    await seedPack(first)
    await first.close()

    const reopened = new RacePackStore(packDirectory)
    await reopened.open()
    expect(reopened.applied()?.revision).toBe(4)
    const observations = new ObservationCollector(5 * 60 * 1000, () => NOW)
    observations.ingest(observedWindDelta())
    const snapshots = new OnboardSnapshotStore(path.join(directory, 'onboard-plans', 'state.json'))
    await snapshots.open()
    const service = new OnboardRaceService({
      packs: reopened,
      snapshots,
      observations,
      course: () => ({ courseId: 'race-42', racePlanId: 42, courseDefinitionDigest: FIXTURE_COURSE_DIGEST, activeIndex: 1, totalPoints: 3, reverse: false }),
      racing: () => true,
      now: () => NOW
    })
    await service.setAuthority('local_only')
    expect(snapshots.latest()!.plan.legs.length).toBeGreaterThan(0)
    service.close()
  })
})
