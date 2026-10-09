import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mqtt from 'mqtt'
import { afterEach, expect, it, vi } from 'vitest'
import pluginConstructor from '../../src/index'
import { CredentialStore } from '../../src/pairing/credentials'
import { RecordingStore } from '../../src/trips/recording-store'
import { WakeLoggerTransport } from '../../src/transport/mqtt-client'
import { FileOutbox } from '../../src/outbox/file-outbox'
const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracking-controls-')); directories.push(dir)
  await new CredentialStore(path.join(dir, 'identity')).save({ version: 1, deviceId: 'dev_controls', clientId: 'dev_controls', username: 'dev_controls', password: 'long-test-password', mqttHost: 'localhost', mqttPort: 1, tls: false, pairedAt: 1000 })
  let configuration: any = { uploadMode: 'local_only', samplePeriodMs: 250, debugTelemetry: true }
  const handlers: Record<string, any> = {}
  const accessLevels: Record<string, string> = {}
  let ingest: any
  const app: any = { getDataDirPath: () => dir, setPluginStatus: vi.fn(), setPluginError: vi.fn(), error: vi.fn(), debug: Object.assign(vi.fn(), { enabled: false }),
    readPluginOptions: () => ({ configuration }),
    savePluginOptions: vi.fn((value, callback) => { configuration = value; callback() }),
    subscriptionmanager: { subscribe: vi.fn((_options, unsub, _error, callback) => { ingest = callback; unsub.push(vi.fn()) }) } }
  const plugin = pluginConstructor(app)
  const registrar = (level: string) => ({
    get: (route: string, handler: any) => { handlers[`GET ${route}`] = handler; accessLevels[`GET ${route}`] = level },
    post: (route: string, handler: any) => { handlers[`POST ${route}`] = handler; accessLevels[`POST ${route}`] = level }
  })
  plugin.registerWithRouter?.({
    access: (level: string) => registrar(level),
    post: (route: string, handler: any) => { handlers[`POST ${route}`] = handler; accessLevels[`POST ${route}`] = 'admin' }
  } as any)
  async function request(method: string, body?: unknown, route = '/tracking') {
    let code = 0; let data: any
    const response = { status(value: number) { code = value; return this }, json(value: unknown) { data = value } }
    await handlers[`${method} ${route}`]({ body }, response, (error: unknown) => { throw error })
    return { code, data }
  }
  plugin.start(configuration, vi.fn())
  await vi.waitFor(async () => expect((await request('GET')).data.available).toBe(true), { timeout: 10000 })
  return { dir, app, plugin, request, accessLevels, configuration: () => configuration, ingest: () => ingest({ updates: [{ timestamp: new Date().toISOString(), values: [{ path: 'navigation.position', value: { latitude: -27, longitude: 153 } }, { path: 'navigation.speedOverGround', value: 2 }] }] }) }
}
it('toggles persistently without replacing the sampler or splitting the recording', async () => {
  const connect = vi.spyOn(mqtt, 'connect')
  const f = await fixture()
  try {
    const scan = vi.spyOn(FileOutbox.prototype, 'stats')
    const scanCount = scan.mock.calls.length
    await Promise.all(Array.from({ length: 20 }, () => f.request('GET')))
    expect(scan).toHaveBeenCalledTimes(scanCount)
    f.ingest()
    await vi.waitFor(async () => expect((await f.request('GET')).data.queue.currentSequence).toBeGreaterThan(0), { timeout: 15000 })
    const before = JSON.parse(await fs.readFile(path.join(f.dir, 'recordings/dev_controls/state.json'), 'utf8'))
    expect((await f.request('POST', { uploadMode: 'automatic' })).code).toBe(200)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(f.configuration()).toMatchObject({ uploadMode: 'automatic', debugTelemetry: true })
    const paused = await f.request('POST', { uploadMode: 'local_only' })
    expect(paused.data).toMatchObject({ uploadMode: 'local_only', persistedUploadMode: 'local_only', recording: true, connectionState: 'recording_locally' })
    f.ingest()
    await vi.waitFor(async () => expect((await f.request('GET')).data.queue.currentSequence).toBeGreaterThan(before.lastSequence), { timeout: 15000 })
    const after = JSON.parse(await fs.readFile(path.join(f.dir, 'recordings/dev_controls/state.json'), 'utf8'))
    expect(after.active.id).toBe(before.active.id)
    expect(f.app.subscriptionmanager.subscribe).toHaveBeenCalledTimes(1)
    await f.plugin.stop(); f.plugin.start(f.configuration(), vi.fn())
    await vi.waitFor(async () => expect((await f.request('GET')).data.available).toBe(true))
    expect(connect).toHaveBeenCalledTimes(1)
    expect((await f.request('GET')).data.uploadMode).toBe('local_only')
  } finally { await f.plugin.stop() }
})
it('pauses immediately behind a pending enable save and serializes the final persisted choice', async () => {
  const connect = vi.spyOn(mqtt, 'connect')
  const f = await fixture()
  try {
    let release: (() => void) | undefined
    f.app.savePluginOptions.mockImplementationOnce((_value: unknown, callback: () => void) => { release = callback })
    const enabling = f.request('POST', { uploadMode: 'automatic' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const disabling = f.request('POST', { uploadMode: 'local_only' })
    expect((await f.request('GET')).data.uploadMode).toBe('local_only')
    release!(); await Promise.all([enabling, disabling])
    expect(connect).not.toHaveBeenCalled()
    expect(f.configuration().uploadMode).toBe('local_only')
  } finally { await f.plugin.stop() }
})
it('keeps upload paused on save failure and persists a restart safety guard', async () => {
  const connect = vi.spyOn(mqtt, 'connect')
  const f = await fixture()
  try {
    f.app.savePluginOptions.mockImplementationOnce((_value: unknown, callback: (error: Error) => void) => callback(new Error('disk unavailable')))
    const response = await f.request('POST', { uploadMode: 'automatic' })
    expect(response.code).toBe(503)
    expect(response.data).toMatchObject({ uploadMode: 'local_only', persistenceError: 'disk unavailable' })
    expect(JSON.parse(await fs.readFile(path.join(f.dir, 'tracking-pause.json'), 'utf8')).paused).toBe(true)
    await f.plugin.stop(); f.plugin.start({ uploadMode: 'automatic' }, vi.fn())
    await vi.waitFor(async () => expect((await f.request('GET')).data.available).toBe(true))
    expect((await f.request('GET')).data.uploadMode).toBe('local_only')
    expect(connect).not.toHaveBeenCalled()
  } finally { await f.plugin.stop() }
})
it('waits for an in-flight options save during shutdown and never starts its obsolete transport', async () => {
  const connect = vi.spyOn(mqtt, 'connect')
  const f = await fixture()
  try {
    let release: (() => void) | undefined
    f.app.savePluginOptions.mockImplementationOnce((_value: unknown, callback: () => void) => { release = callback })
    const enabling = f.request('POST', { uploadMode: 'automatic' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    let stopped = false
    const shutdown = Promise.resolve(f.plugin.stop()).then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stopped).toBe(false)
    release!(); await Promise.all([enabling, shutdown])
    expect(connect).not.toHaveBeenCalled()
    expect(stopped).toBe(true)
  } finally { await f.plugin.stop() }
})
it('opens onboard reads and controls to non-admin users and keeps unpairing admin-only', async () => {
  const f = await fixture()
  try {
    expect(f.accessLevels).toMatchObject({
      'GET /tracking': 'readonly',
      'GET /course': 'readonly',
      'POST /tracking': 'readwrite',
      'POST /course/activate': 'readwrite',
      'POST /course/map-readiness': 'readwrite',
      'POST /forget-credentials': 'admin'
    })
  } finally { await f.plugin.stop() }
})

it('finishes offline through the local route without samples, navigation writes or lost archive history', async () => {
  const statuses = vi.spyOn(WakeLoggerTransport.prototype, 'updateStatus')
  const f = await fixture()
  try {
    f.ingest()
    let checkpoint: any
    // A slow CI filesystem can take longer than vi.waitFor's 1s default to
    // flush the checkpoint; the assertion inside the poll is the real check.
    await vi.waitFor(async () => {
      checkpoint = JSON.parse(await fs.readFile(path.join(f.dir, 'recordings/dev_controls/state.json'), 'utf8'))
      expect(checkpoint.committed?.sequence).toBeGreaterThan(0)
    }, { timeout: 15000 })
    const id = checkpoint.active.id
    const result = await f.request('POST', { expectedRecordingId: id }, '/tracking/finish')
    expect(result.code).toBe(200)
    expect(result.data).toMatchObject({ uploadMode: 'local_only', trackingState: 'STOPPED', trackingSessionId: null,
      finishedTrip: { uploadPending: true, manifest: { id, state: 'complete', lastSequence: checkpoint.committed.sequence, endedAt: checkpoint.committed.capturedAt } } })
    expect(f.accessLevels['POST /tracking/finish']).toBe('readwrite')
    expect(statuses.mock.calls.at(-1)?.[0].recordings).toContainEqual(result.data.finishedTrip.manifest)
    expect((await f.request('POST', { expectedRecordingId: id }, '/tracking/finish')).code).toBe(200)
    const after = JSON.parse(await fs.readFile(path.join(f.dir, 'recordings/dev_controls/state.json'), 'utf8'))
    expect(after.lastSequence).toBe(checkpoint.lastSequence)
    expect(after.closed).toHaveLength(1)
    const archives = await fs.readdir(path.join(f.dir, 'track-archive/dev_controls'))
    expect(archives.length).toBeGreaterThan(0)
    const archive = JSON.parse(await fs.readFile(path.join(f.dir, 'track-archive/dev_controls/manifest.json'), 'utf8'))
    expect(archive.recordings).toContainEqual(expect.objectContaining({ id, closed: true, points: 1, lastSequence: checkpoint.committed.sequence, endedAt: checkpoint.committed.capturedAt }))
    await f.plugin.stop(); f.plugin.start(f.configuration(), vi.fn())
    await vi.waitFor(async () => expect((await f.request('GET')).data.available).toBe(true))
    expect((await f.request('GET')).data.finishedTrip.uploadPending).toBe(true)
    f.ingest()
    await vi.waitFor(async () => expect((await f.request('GET')).data.trackingSessionId).not.toBeNull())
    const newId = (await f.request('GET')).data.trackingSessionId
    expect(newId).not.toBe(id)
    expect((await f.request('POST', { expectedRecordingId: id }, '/tracking/finish')).code).toBe(409)
    expect((await f.request('GET')).data.trackingSessionId).toBe(newId)
  } finally { await f.plugin.stop() }
})

it('serializes Finish trip behind an in-flight durable append and includes its actual sequence', async () => {
  const f = await fixture()
  const append = FileOutbox.prototype.append
  let release: (() => void) | undefined
  const held = vi.spyOn(FileOutbox.prototype, 'append').mockImplementationOnce(async function (this: FileOutbox, ...args) {
    await new Promise<void>((resolve) => { release = resolve })
    return append.apply(this, args)
  })
  try {
    f.ingest()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const checkpoint = JSON.parse(await fs.readFile(path.join(f.dir, 'recordings/dev_controls/state.json'), 'utf8'))
    let finished = false
    const closing = f.request('POST', { expectedRecordingId: checkpoint.active.id }, '/tracking/finish').then(result => { finished = true; return result })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(finished).toBe(false)
    release!()
    const result = await closing
    expect(result.code).toBe(200)
    expect(result.data.finishedTrip.manifest.lastSequence).toBe(checkpoint.lastSequence)
    expect(held).toHaveBeenCalledTimes(1)
  } finally { release?.(); held.mockRestore(); await f.plugin.stop() }
})
it('refuses a prepared but failed tail append rather than silently completing a shorter range', async () => {
  const f = await fixture()
  try {
    f.ingest()
    let checkpoint: any
    await vi.waitFor(async () => {
      checkpoint = JSON.parse(await fs.readFile(path.join(f.dir, 'recordings/dev_controls/state.json'), 'utf8'))
      expect(checkpoint.committed?.sequence).toBeGreaterThan(0)
    }, { timeout: 15000 })
    vi.spyOn(FileOutbox.prototype, 'append').mockRejectedValueOnce(new Error('append unavailable'))
    f.ingest()
    await vi.waitFor(() => expect(f.app.error).toHaveBeenCalledWith(expect.stringContaining('append unavailable')))
    const result = await f.request('POST', { expectedRecordingId: checkpoint.active.id }, '/tracking/finish')
    expect(result.code).toBe(409)
    expect(result.data.error).toBe('recording_not_committed')
    expect(result.data.trackingSessionId).toBe(checkpoint.active.id)
    expect(result.data.finishedTrip).toBeNull()
  } finally { await f.plugin.stop() }
})

it('keeps Finish trip available after a recording receipt persistence failure', async () => {
  const statuses = vi.spyOn(WakeLoggerTransport.prototype, 'updateStatus')
  const f = await fixture()
  try {
    f.ingest()
    await vi.waitFor(async () => expect((await f.request('GET')).data.trackingSessionId).toBeTruthy())
    const id = (await f.request('GET')).data.trackingSessionId
    await f.request('POST', { uploadMode: 'automatic' })
    const transport = statuses.mock.instances.at(-1) as any
    vi.spyOn(RecordingStore.prototype, 'acknowledge').mockRejectedValueOnce(new Error('checkpoint unavailable'))
    await expect(transport.options.onRecordingAcks([{ id, state: 'complete', lastSequence: 1 }])).rejects.toThrow('checkpoint unavailable')
    const finished = await f.request('POST', { expectedRecordingId: id }, '/tracking/finish')
    expect(finished.code).toBe(200)
    expect(finished.data.finishedTrip.manifest.id).toBe(id)
  } finally { await f.plugin.stop() }
})
