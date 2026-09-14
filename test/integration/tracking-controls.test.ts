import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mqtt from 'mqtt'
import { afterEach, expect, it, vi } from 'vitest'
import pluginConstructor from '../../src/index'
import { CredentialStore } from '../../src/pairing/credentials'
const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracking-controls-')); directories.push(dir)
  await new CredentialStore(path.join(dir, 'identity')).save({ version: 1, deviceId: 'dev_controls', clientId: 'dev_controls', username: 'dev_controls', password: 'long-test-password', mqttHost: 'localhost', mqttPort: 1, tls: false, pairedAt: 1000 })
  let configuration: any = { uploadMode: 'local_only', samplePeriodMs: 250, debugTelemetry: true }
  const handlers: Record<string, any> = {}
  let ingest: any
  const app: any = { getDataDirPath: () => dir, setPluginStatus: vi.fn(), setPluginError: vi.fn(), error: vi.fn(), debug: Object.assign(vi.fn(), { enabled: false }),
    readPluginOptions: () => ({ configuration }),
    savePluginOptions: vi.fn((value, callback) => { configuration = value; callback() }),
    subscriptionmanager: { subscribe: vi.fn((_options, unsub, _error, callback) => { ingest = callback; unsub.push(vi.fn()) }) } }
  const plugin = pluginConstructor(app)
  plugin.registerWithRouter?.({ get: (route: string, handler: any) => { handlers[`GET ${route}`] = handler }, post: (route: string, handler: any) => { handlers[`POST ${route}`] = handler } } as any)
  async function request(method: string, body?: unknown) {
    let code = 0; let data: any
    const response = { status(value: number) { code = value; return this }, json(value: unknown) { data = value } }
    await handlers[`${method} /tracking`]({ body }, response, (error: unknown) => { throw error })
    return { code, data }
  }
  plugin.start(configuration, vi.fn())
  await vi.waitFor(async () => expect((await request('GET')).data.available).toBe(true), { timeout: 10000 })
  return { dir, app, plugin, request, configuration: () => configuration, ingest: () => ingest({ updates: [{ timestamp: new Date().toISOString(), values: [{ path: 'navigation.position', value: { latitude: -27, longitude: 153 } }, { path: 'navigation.speedOverGround', value: 2 }] }] }) }
}
it('toggles persistently without replacing the sampler or splitting the recording', async () => {
  const connect = vi.spyOn(mqtt, 'connect')
  const f = await fixture()
  try {
    f.ingest()
    await vi.waitFor(async () => expect((await f.request('GET')).data.queue.currentSequence).toBeGreaterThan(0), { timeout: 3000 })
    const before = JSON.parse(await fs.readFile(path.join(f.dir, 'recordings/dev_controls/state.json'), 'utf8'))
    expect((await f.request('POST', { uploadMode: 'automatic' })).code).toBe(200)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(f.configuration()).toMatchObject({ uploadMode: 'automatic', debugTelemetry: true })
    const paused = await f.request('POST', { uploadMode: 'local_only' })
    expect(paused.data).toMatchObject({ uploadMode: 'local_only', persistedUploadMode: 'local_only', recording: true, connectionState: 'recording_locally' })
    f.ingest()
    await vi.waitFor(async () => expect((await f.request('GET')).data.queue.currentSequence).toBeGreaterThan(before.lastSequence), { timeout: 3000 })
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
