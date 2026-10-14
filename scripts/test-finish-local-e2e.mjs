// Disposable actual compiled plugin + real HTTP + browser, offline local-only.
// No cloud/Signal K server acceptance is claimed.
// Signal K subscription/resources are an adapter fixture, not a Signal K server.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'
const require = createRequire(import.meta.url)
const pluginConstructor = require('../dist/index.js')
const { CredentialStore } = require('../dist/pairing/credentials.js')
const { WakeLoggerTransport } = require('../dist/transport/mqtt-client.js')
const credentials = { version: 1, deviceId: 'dev_finish_local', clientId: 'dev_finish_local', username: 'dev_finish_local', password: 'synthetic-local-only', mqttHost: '127.0.0.1', mqttPort: 1, tls: false, pairedAt: Date.now() }
const directory = await fs.mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || os.tmpdir(), 'finish-local-plugin-'))
await new CredentialStore(path.join(directory, 'identity')).save(credentials)
const handlers = new Map()
const instances = []
const start = WakeLoggerTransport.prototype.start
WakeLoggerTransport.prototype.start = function () { instances.push(this); return start.call(this) }
let ingest
let configuration = { uploadMode: 'local_only', samplePeriodMs: 250 }
const errors = []
const nativeWrites = []
const app = {
  getDataDirPath: () => directory,
  readPluginOptions: () => ({ configuration }),
  savePluginOptions: (value, callback) => { configuration = value; callback() },
  setPluginStatus() {}, setPluginError() {}, error: value => errors.push(value), debug() {},
  handleMessage: (...args) => nativeWrites.push(args),
  subscriptionmanager: { subscribe: (_options, unsubs, _error, callback) => { ingest = callback; unsubs.push(() => {}) } }
}
const plugin = pluginConstructor(app)
const registrar = { get: (route, handler) => handlers.set(`GET ${route}`, handler), post: (route, handler) => handlers.set(`POST ${route}`, handler) }
plugin.registerWithRouter({ ...registrar, access: () => registrar })
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const route = url.pathname.replace(/^\/plugins\/signalk-wakelogger/, '')
  const handler = handlers.get(`${request.method} ${route}`)
  try {
    if (handler) {
      let body = ''; for await (const chunk of request) body += chunk
      const adapter = { status(code) { response.statusCode = code; return this }, json(value) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) } }
      await handler({ body: body ? JSON.parse(body) : undefined, query: Object.fromEntries(url.searchParams) }, adapter, error => { throw error })
      return
    }
    if (url.pathname.startsWith('/signalk')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return }
    const relative = url.pathname === '/' ? '/index.html' : url.pathname
    const target = path.resolve('public', `.${relative}`)
    assert.ok(target.startsWith(`${path.resolve('public')}${path.sep}`))
    const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' }).end(await fs.readFile(target))
  } catch { if (!response.headersSent) response.writeHead(500); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
async function tracking() { return fetch(`${base}/plugins/signalk-wakelogger/tracking`).then(response => response.json()) }
async function until(description, predicate, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(`Timed out: ${description}; errors=${JSON.stringify(errors.slice(-3))}`)
}
let browser
try {
  plugin.start(configuration, () => {})
  await until('actual plugin recorder', async () => (await tracking()).available)
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(base)
  await until('no trip explanation', async () => (await page.locator('#finish-trip-reason').textContent()).includes('No trip is in progress'))
  ingest({ updates: [{ timestamp: new Date().toISOString(), values: [
    { path: 'navigation.position', value: { latitude: -27.4, longitude: 153.17 } },
    { path: 'navigation.speedOverGround', value: 2 }
  ] }] })
  const checkpointPath = path.join(directory, 'recordings/dev_finish_local/state.json')
  const checkpoint = await until('durable sample', async () => {
    let state
    try { state = JSON.parse(await fs.readFile(checkpointPath, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
    return state.committed?.sequence > 0 && state
  })
  await until('Finish enabled', async () => page.locator('#finish-trip').isEnabled())
  await page.locator('#finish-trip').focus()
  await page.keyboard.press('Enter')
  await until('actual local Finish response', async () => {
    const state = await tracking()
    return !state.trackingSessionId && state.finishedTrip?.manifest?.state === 'complete'
  })
  let state = await tracking()
  assert.equal(state.finishedTrip.manifest.id, checkpoint.active.id)
  assert.equal(state.finishedTrip.manifest.lastSequence, checkpoint.committed.sequence)
  assert.equal(state.finishedTrip.manifest.endedAt, checkpoint.committed.capturedAt)
  assert.equal(state.uploadMode, 'local_only')
  await until('saved onboard shown', async () => (await page.locator('#finished-trip').textContent()).includes('saved onboard'))
  await page.locator('#finish-trip').click() // Real idempotent confirmation retry.
  await until('retry response released', async () => (await page.locator('#finish-trip').getAttribute('aria-busy')) === 'false')
  assert.equal(JSON.parse(await fs.readFile(checkpointPath, 'utf8')).closed.length, 1)
  await page.reload()
  await until('reload retry available', async () => page.getByRole('button', { name: 'Retry confirmation', exact: true }).isEnabled())
  await plugin.stop()
  plugin.start(configuration, () => {})
  await until('restart recorder', async () => (await tracking()).available)
  state = await tracking()
  assert.equal(state.finishedTrip.manifest.id, checkpoint.active.id)
  assert.equal(state.finishedTrip.manifest.lastSequence, checkpoint.committed.sequence)
  assert.equal(state.finishedTrip.confirmationPending, true)
  assert.deepEqual(nativeWrites, [])
  assert.equal(instances.length, 0, 'local-only must never start MQTT')
  assert.deepEqual(errors, [])
  console.log('PASS actual compiled plugin/local HTTP/browser: keyboard Finish, exact durable bounds, retry, reload, restart; no MQTT or native writes')
} finally {
  await browser?.close()
  await plugin.stop()
  await new Promise(resolve => server.close(resolve))
  await fs.rm(directory, { recursive: true, force: true })
}
