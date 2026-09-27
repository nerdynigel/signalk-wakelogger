import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import pluginConstructor from '../../src/index'
import { CredentialStore } from '../../src/pairing/credentials'
import { nativeRouteHref } from '../../src/courses/native-course'
import { RacePackReceiver } from '../../src/race/race-pack-protocol'
import { RacePackStore } from '../../src/race/race-pack-store'
import { encodeFixturePack, makeFixturePack, FIXTURE_COURSE_DIGEST } from '../helpers/race-pack'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

const deviceId = 'dev_remediation'
const courseDocument = {
  v: 1, action: 'activate', revision: 7, courseId: 'race-42', racePlanId: 42,
  courseDefinitionDigest: FIXTURE_COURSE_DIGEST,
  name: 'Field incident course', updatedAt: '2026-09-13T01:00:00Z',
  start: { id: 'start', name: 'Race start', latitude: -27.4, longitude: 153.17 },
  marks: [{ id: 'mark-1', name: 'Eastern mark', latitude: -27.39, longitude: 153.17 }],
  finish: { id: 'finish', name: 'Race finish', latitude: -27.39, longitude: 153.19 },
  activeWaypointIndex: 1
}

async function seedPack(directory: string): Promise<void> {
  const packs = new RacePackStore(path.join(directory, 'race-packs', deviceId))
  await packs.open()
  const encoded = encodeFixturePack(makeFixturePack(), { chunkCount: 2 })
  const receiver = new RacePackReceiver({ store: packs })
  await receiver.acceptManifest(encoded.manifestPayload)
  for (const [index, chunk] of encoded.chunkPayloads.entries()) await receiver.acceptChunk(chunk, index)
  await packs.close()
}

async function seedCourse(directory: string): Promise<void> {
  const target = path.join(directory, 'courses', deviceId, 'state.json')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify({
    version: 1,
    desired: courseDocument,
    cachedCourse: courseDocument,
    acknowledgement: { v: 1, revision: 7, status: 'applied', activation: 'active' }
  }))
}

async function fixture(options: { seed?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remediation-integration-'))
  directories.push(directory)
  await new CredentialStore(path.join(directory, 'identity')).save({
    version: 1, deviceId, clientId: deviceId, username: deviceId, password: 'long-test-password',
    mqttHost: 'localhost', mqttPort: 1, tls: false, pairedAt: 1000
  })
  if (options.seed !== false) { await seedPack(directory); await seedCourse(directory) }
  const configuration: any = { uploadMode: 'local_only', samplePeriodMs: 250 }
  const handlers: Record<string, any> = {}
  const accessLevels: Record<string, string> = {}
  let ingest: any
  const resources = new Map<string, any>()
  let nativeCourse: any = { activeRoute: { href: nativeRouteHref('race-42'), pointIndex: 1, pointTotal: 3, name: 'Field incident course' } }
  const errors: string[] = []
  const app: any = {
    getDataDirPath: () => directory,
    setPluginStatus: vi.fn(), setPluginError: vi.fn(),
    error: (message: string) => { errors.push(message) },
    debug: Object.assign(vi.fn(), { enabled: false }),
    readPluginOptions: () => ({ configuration }),
    savePluginOptions: vi.fn((value, callback) => { Object.assign(configuration, value); callback() }),
    resourcesApi: {
      getResource: vi.fn(async (_type: string, id: string) => { if (!resources.has(id)) throw new Error(`Resource not found! (${id})`); return resources.get(id) }),
      setResource: vi.fn(async (_type: string, id: string, value: unknown) => { resources.set(id, structuredClone(value)) })
    },
    getCourse: vi.fn(async () => structuredClone(nativeCourse)),
    activateRoute: vi.fn(async (options: any) => { nativeCourse = { activeRoute: { ...options, pointTotal: 3 } } }),
    clearDestination: vi.fn(async () => { nativeCourse = { activeRoute: null } }),
    subscriptionmanager: { subscribe: vi.fn((_options, unsub, _error, callback) => { ingest = callback; unsub.push(vi.fn()) }) }
  }
  const plugin = pluginConstructor(app)
  const registrar = (level: string) => ({
    get: (route: string, handler: any) => { handlers[`GET ${route}`] = handler; accessLevels[`GET ${route}`] = level },
    post: (route: string, handler: any) => { handlers[`POST ${route}`] = handler; accessLevels[`POST ${route}`] = level }
  })
  plugin.registerWithRouter?.({
    access: (level: string) => registrar(level),
    post: (route: string, handler: any) => { handlers[`POST ${route}`] = handler; accessLevels[`POST ${route}`] = 'admin' }
  } as any)
  async function request(method: string, route: string, body?: unknown) {
    let code = 0; let data: any
    const response = { status(value: number) { code = value; return this }, json(value: unknown) { data = value } }
    await handlers[`${method} ${route}`]({ body, query: {} }, response, (error: unknown) => { throw error })
    return { code, data }
  }
  plugin.start(configuration, vi.fn())
  await vi.waitFor(async () => expect((await request('GET', '/tracking')).data.available).toBe(true), { timeout: 10000 })
  return { directory, app, plugin, request, accessLevels, errors, configuration: () => configuration, ingest: (position: { latitude: number; longitude: number }, at = new Date().toISOString()) => ingest({ updates: [{ timestamp: at, values: [{ path: 'navigation.position', value: position }] }] }) }
}

it('exposes one coupled offline readiness status and invalidation for the field sequence', async () => {
  const f = await fixture()
  try {
    const ready = await f.request('GET', '/offline-readiness')
    expect(ready.code).toBe(200)
    expect(ready.data).toMatchObject({ ready: true, label: 'Offline race ready' })
    expect(ready.data.checks).toMatchObject({ courseApplied: true, nativeActive: true, racePackReady: true, racePackMatches: true, forecastCoversRace: true, ruleSetSupported: true })
    expect(ready.data.missing).toEqual([])
    // The course endpoint carries the same single status.
    expect((await f.request('GET', '/course')).data.offlineReadiness.ready).toBe(true)
  } finally { await f.plugin.stop() }
})

it('reports not-ready with no course and never presents a stale pack as ready', async () => {
  const f = await fixture({ seed: false })
  try {
    const readiness = await f.request('GET', '/offline-readiness')
    expect(readiness.data.ready).toBe(false)
    expect(readiness.data.missing).toContain('no Wake Logger course is selected')
    expect(readiness.data.missing).toContain('no Race Pack has been prepared for this course')
  } finally { await f.plugin.stop() }
})

it('reconstructs the current recording track from durable data and survives restart', async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 4; index += 1) {
      f.ingest({ latitude: -27.4 + index * 0.001, longitude: 153.17 + index * 0.001 })
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    await vi.waitFor(async () => expect((await f.request('GET', '/track')).data.points.length).toBeGreaterThanOrEqual(2), { timeout: 10000 })
    const first = (await f.request('GET', '/track')).data
    expect(first.recording).toMatchObject({ state: 'recording' })
    const sequences = first.points.map((point: any) => point.sequence)
    expect([...sequences].sort((a: number, b: number) => a - b)).toEqual(sequences)
    expect(first.summary.totalSamples).toBeGreaterThanOrEqual(2)

    await f.plugin.stop()
    f.plugin.start(f.configuration(), vi.fn())
    await vi.waitFor(async () => expect((await f.request('GET', '/tracking')).data.available).toBe(true), { timeout: 10000 })
    const afterReload = (await f.request('GET', '/track')).data
    expect(afterReload.points.length).toBeGreaterThanOrEqual(2)
    expect(afterReload.summary.fromSequence).toBe(first.summary.fromSequence)
  } finally { await f.plugin.stop() }
})

it('records bounded, credentialed-safe webapp diagnostics without leaking secrets', async () => {
  const f = await fixture()
  try {
    const response = await f.request('POST', '/diagnostics', {
      operation: 'next-point', method: 'PUT', path: '/signalk/v2/api/vessels/self/navigation/course/activeRoute/nextPoint',
      status: 409, errorCode: 'native_route_conflict', detail: 'Bearer super-secret token=abc123 rejected'
    })
    expect(response.code).toBe(200)
    const logged = f.errors.find((message) => message.includes('onboard webapp next-point'))
    expect(logged).toBeTruthy()
    expect(logged).toContain('409')
    expect(logged).toContain('native_route_conflict')
    expect(logged).not.toContain('super-secret')
    expect(logged).not.toContain('abc123')
  } finally { await f.plugin.stop() }
})

it('exposes onboard routes at the least privilege that works', async () => {
  const f = await fixture()
  try {
    expect(f.accessLevels).toMatchObject({
      'GET /offline-readiness': 'readonly',
      'GET /track': 'readonly',
      'POST /diagnostics': 'readonly',
      'GET /course': 'readonly',
      'POST /course/activate': 'readwrite'
    })
  } finally { await f.plugin.stop() }
})
