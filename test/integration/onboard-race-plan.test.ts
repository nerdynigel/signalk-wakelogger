import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import mqtt from 'mqtt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pluginConstructor from '../../src/index'
import { CredentialStore } from '../../src/pairing/credentials'
import { nativeRouteHref } from '../../src/courses/native-course'
import { RacePackReceiver, type RacePackAck } from '../../src/race/race-pack-protocol'
import { RacePackStore } from '../../src/race/race-pack-store'
import { encodeFixturePack, makeFixturePack, FIXTURE_COURSE_DIGEST } from '../helpers/race-pack'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

const COURSE = {
  v: 1, action: 'activate', revision: 7, courseId: 'race-42', racePlanId: 42, name: 'Saturday bay race',
  courseDefinitionDigest: FIXTURE_COURSE_DIGEST,
  updatedAt: '2026-09-13T01:00:00Z',
  start: { id: 'start', name: 'Race start', latitude: -27.4, longitude: 153.17 },
  marks: [{ id: 'mark-1', name: 'Eastern mark', latitude: -27.39, longitude: 153.17 }],
  finish: { id: 'finish', name: 'Race finish', latitude: -27.39, longitude: 153.19 }
}

async function seedPack(directory: string): Promise<void> {
  const store = new RacePackStore(path.join(directory, 'race-packs', 'dev_onboard'))
  const encoded = encodeFixturePack(makeFixturePack(), { chunkCount: 2 })
  const receiver = new RacePackReceiver({ store })
  await receiver.acceptManifest(encoded.manifestPayload)
  let ack: RacePackAck | null = null
  for (const [index, payload] of encoded.chunkPayloads.entries()) ack = await receiver.acceptChunk(payload, index)
  expect(ack).toMatchObject({ status: 'applied' })
  await store.close()
}

interface Harness {
  directory: string
  ingest: (delta: unknown) => void
  request: (method: string, route: string, body?: unknown) => Promise<{ code: number; data: any }>
  statuses: string[]
  start: (config: object) => void
  stop: () => Promise<void>
}

async function fixture(): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onboard-integration-'))
  directories.push(directory)
  await new CredentialStore(path.join(directory, 'identity')).save({ version: 1, deviceId: 'dev_onboard', clientId: 'dev_onboard', username: 'dev_onboard', password: 'a-very-long-secret', mqttHost: 'localhost', mqttPort: 1, tls: false, pairedAt: 1000 })
  await seedPack(directory)
  await fs.mkdir(path.join(directory, 'courses', 'dev_onboard'), { recursive: true })
  await fs.writeFile(path.join(directory, 'courses', 'dev_onboard', 'state.json'), JSON.stringify({ version: 1, desired: COURSE, cachedCourse: COURSE, acknowledgement: { v: 1, revision: 7, status: 'applied' } }))

  const resources = new Map<string, unknown>()
  let ingest: ((delta: unknown) => void) | undefined
  let configuration: Record<string, unknown> = { uploadMode: 'local_only' }
  const handlers: Record<string, (request: unknown, response: any, next: (error: unknown) => void) => Promise<void> | void> = {}
  const statuses: string[] = []
  const app: any = {
    getDataDirPath: () => directory,
    setPluginStatus: (status: string) => statuses.push(status),
    setPluginError: vi.fn(), error: vi.fn(), debug: Object.assign(vi.fn(), { enabled: false }),
    readPluginOptions: () => ({ configuration }),
    savePluginOptions: (value: Record<string, unknown>, callback: () => void) => { configuration = value; callback() },
    resourcesApi: {
      getResource: async (type: string, id: string) => {
        const value = resources.get(`${type}/${id}`)
        if (!value) { const error = new Error('not found') as Error & { status: number }; error.status = 404; throw error }
        return value
      },
      setResource: async (type: string, id: string, value: unknown) => { resources.set(`${type}/${id}`, value) }
    },
    getCourse: () => ({ activeRoute: { href: nativeRouteHref('race-42'), pointIndex: 1, pointTotal: 3, reverse: false } }),
    activateRoute: async () => undefined,
    clearDestination: async () => undefined,
    subscriptionmanager: { subscribe: (_options: unknown, _unsub: unknown, _error: unknown, callback: (delta: unknown) => void) => { ingest = callback } }
  }
  const plugin = pluginConstructor(app)
  const registrar = (level: string) => ({
    get: (route: string, handler: any) => { handlers[`GET ${route}`] = handler; void level },
    post: (route: string, handler: any) => { handlers[`POST ${route}`] = handler; void level }
  })
  plugin.registerWithRouter?.({ access: (level: string) => registrar(level), post: (route: string, handler: any) => { handlers[`POST ${route}`] = handler } } as never)

  const request = async (method: string, route: string, body?: unknown) => {
    let code = 0; let data: any
    const response = { status(value: number) { code = value; return this }, json(value: unknown) { data = value } }
    const handler = handlers[`${method} ${route}`]
    if (!handler) throw new Error(`No handler for ${method} ${route}`)
    await handler({ body }, response, (error: unknown) => { throw error })
    return { code, data }
  }
  const start = (config: object) => plugin.start(config, vi.fn())
  return { directory, ingest: (delta) => ingest?.(delta), request, statuses, start, stop: () => Promise.resolve(plugin.stop()) }
}

function navDelta(): unknown {
  return { updates: [{ timestamp: new Date().toISOString(), values: [
    { path: 'navigation.position', value: { latitude: -27.395, longitude: 153.18 } },
    { path: 'navigation.speedOverGround', value: 3.1 },
    { path: 'navigation.courseOverGroundTrue', value: 0.2 },
    { path: 'navigation.headingTrue', value: 0.2 },
    { path: 'environment.wind.speedTrue', value: 7.2 },
    { path: 'environment.wind.directionTrue', value: 0.7854 }
  ] }] }
}

class FakeMqttClient extends EventEmitter {
  connected = false
  publications: Array<{ topic: string; payload: string; options: unknown }> = []
  subscriptions: string[] = []
  publish(topic: string, payload: string, options: unknown, callback?: (error?: Error) => void): void {
    this.publications.push({ topic, payload, options }); callback?.()
  }
  subscribe(topic: string | Record<string, unknown>, callbackOrOptions?: unknown, maybeCallback?: (error?: Error) => void): void {
    this.subscriptions.push(...(typeof topic === 'string' ? [topic] : Object.keys(topic)))
    const callback = typeof callbackOrOptions === 'function' ? callbackOrOptions as (error?: Error) => void : maybeCallback
    callback?.()
  }
  end(_force?: boolean, _options?: object, callback?: (error?: Error) => void): void { callback?.() }
}

describe('onboard race plan integration', () => {
  it('loads a persisted pack, calculates offline on demand and survives restart without network traffic', async () => {
    const connect = vi.spyOn(mqtt, 'connect')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const f = await fixture()
    const config = { uploadMode: 'local_only', samplePeriodMs: 250, debugTelemetry: true }
    try {
      f.start(config)
      await vi.waitFor(async () => {
        const data = (await f.request('GET', '/race-plan')).data
        expect(data.pack?.available).toBe(true)
        expect(data.connectionState).toBe('recording_locally')
        expect(data.calculationAuthority).toBe('onboard')
      }, { timeout: 10000 })
      let racePlan = (await f.request('GET', '/race-plan')).data
      expect(racePlan).toMatchObject({ calculationAuthority: 'onboard', uploadMode: 'local_only', connectionState: 'recording_locally' })
      expect(racePlan.pack).toMatchObject({ available: true, revision: 4, courseId: 'race-42', racePlanId: 42 })
      // Before observations are ready the planner may already return a
      // forecast-fallback snapshot rather than disappearing.
      if (racePlan.latestSnapshot) {
        expect(racePlan.latestSnapshot.plan.legs[0].conditions.source).toBe('forecast')
        expect(racePlan.latestSnapshot.warning).toMatch(/Fresh onboard observations not yet available/)
      }

      f.ingest(navDelta())
      const recalculation = await f.request('POST', '/race-plan/recalculate')
      expect(recalculation.code).toBe(200)
      expect(recalculation.data.calculated).toBe(true)
      racePlan = (await f.request('GET', '/race-plan')).data
      expect(racePlan.latestSnapshot).toMatchObject({ source: 'onboard', packRevision: 4 })
      expect(racePlan.latestSnapshot.plan.legs.length).toBeGreaterThan(0)
      expect(racePlan.latestSnapshot.tracking).toMatchObject({ activeIndex: 1 })
      expect(racePlan.observations.windSource).toBe('true')

      await f.stop()
      f.start(config)
      await vi.waitFor(async () => {
        const data = (await f.request('GET', '/race-plan')).data
        expect(data.pack?.available).toBe(true)
        expect(data.connectionState).toBe('recording_locally')
        expect(data.calculationAuthority).toBe('onboard')
      }, { timeout: 10000 })
      f.ingest(navDelta())
      const afterRestart = await f.request('POST', '/race-plan/recalculate')
      expect(afterRestart.data.calculated).toBe(true)
      expect((await f.request('GET', '/race-plan')).data.latestSnapshot).not.toBeNull()

      expect(connect).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { await f.stop() }
  })

  it('does not run the onboard planner while Live tracking is automatic', async () => {
    vi.spyOn(mqtt, 'connect').mockImplementation(() => ({
      connected: false, on: () => undefined,
      end: (_force?: boolean, _options?: object, callback?: () => void) => callback?.(),
      publish: (_topic: string, _payload: string, _options: object, callback?: (error?: Error) => void) => callback?.(),
      subscribe: (_topic: unknown, callback?: (error?: Error) => void) => callback?.()
    }) as unknown as ReturnType<typeof mqtt.connect>)
    vi.stubGlobal('fetch', vi.fn())
    const f = await fixture()
    try {
      f.start({ uploadMode: 'automatic', samplePeriodMs: 250 })
      await vi.waitFor(async () => expect((await f.request('GET', '/race-plan')).data.connectionState).not.toBe('unpaired'), { timeout: 10000 })
      const racePlan = (await f.request('GET', '/race-plan')).data
      expect(racePlan.calculationAuthority).toBe('cloud')
      expect(racePlan.latestSnapshot).toBeNull()
      f.ingest(navDelta())
      const recalculation = await f.request('POST', '/race-plan/recalculate')
      expect(recalculation.code).toBe(409)
      expect(recalculation.data.error).toBe('cloud_authority')
      expect((await f.request('GET', '/race-plan')).data.latestSnapshot).toBeNull()
    } finally { await f.stop() }
  })

  it('queues onboard snapshots while local-only and uploads them when Live tracking returns', async () => {
    const clients: FakeMqttClient[] = []
    vi.spyOn(mqtt, 'connect').mockImplementation(() => {
      const client = new FakeMqttClient()
      clients.push(client)
      return client as unknown as ReturnType<typeof mqtt.connect>
    })
    vi.stubGlobal('fetch', vi.fn())
    const f = await fixture()
    const config = { uploadMode: 'local_only', samplePeriodMs: 250 }
    try {
      f.start(config)
      await vi.waitFor(async () => expect((await f.request('GET', '/race-plan')).data.calculationAuthority).toBe('onboard'), { timeout: 10000 })
      f.ingest(navDelta())
      await f.request('POST', '/race-plan/recalculate')
      expect((await f.request('GET', '/race-plan')).data.latestSnapshot).not.toBeNull()
      // local_only produces no transport at all.
      expect(clients).toHaveLength(0)

      const switched = await f.request('POST', '/tracking', { uploadMode: 'automatic' })
      expect(switched.code).toBe(200)
      await vi.waitFor(() => expect(clients).toHaveLength(1), { timeout: 10000 })
      const client = clients[0]!
      client.connected = true
      client.emit('connect')
      await vi.waitFor(() => {
        expect(client.publications.some((entry) => entry.topic.endsWith('/events') && entry.payload.includes('race_plan_snapshot'))).toBe(true)
      }, { timeout: 10000 })
      const event = client.publications.find((entry) => entry.topic.endsWith('/events') && entry.payload.includes('race_plan_snapshot'))!
      expect(JSON.parse(event.payload)).toMatchObject({ kind: 'race_plan_snapshot', source: 'onboard', packRevision: 4 })
    } finally { await f.stop() }
  })

  it('publishes a final retained local_only status before shutting down and then stays silent', async () => {
    const clients: FakeMqttClient[] = []
    vi.spyOn(mqtt, 'connect').mockImplementation(() => {
      const client = new FakeMqttClient()
      clients.push(client)
      return client as unknown as ReturnType<typeof mqtt.connect>
    })
    vi.stubGlobal('fetch', vi.fn())
    const f = await fixture()
    try {
      f.start({ uploadMode: 'automatic', samplePeriodMs: 250 })
      await vi.waitFor(() => expect(clients).toHaveLength(1), { timeout: 10000 })
      const client = clients[0]!
      client.connected = true
      client.emit('connect')
      await vi.waitFor(() => {
        expect(client.publications.some((entry) => entry.topic.endsWith('/status') && entry.payload.includes('online'))).toBe(true)
      }, { timeout: 10000 })

      const switched = await f.request('POST', '/tracking', { uploadMode: 'local_only' })
      expect(switched.code).toBe(200)
      const localOnly = client.publications.find((entry) => entry.topic.endsWith('/status') && entry.payload.includes('local_only'))
      expect(localOnly).toBeTruthy()
      expect(JSON.parse(localOnly!.payload)).toMatchObject({ state: 'local_only', uploadMode: 'local_only', calculationAuthority: 'onboard' })
      expect(localOnly!.options).toMatchObject({ qos: 1, retain: true })

      // Fail-closed: no further Wake Logger traffic after the transition.
      const count = client.publications.length
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(client.publications.length).toBe(count)
    } finally { await f.stop() }
  })
})
