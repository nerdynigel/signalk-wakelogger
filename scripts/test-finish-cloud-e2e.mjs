// Actual plugin/HTTP/browser/MQTT against an explicitly supplied disposable cloud.
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
assert.equal(process.env.WAKELOGGER_DISPOSABLE_FINISH_E2E, '1', 'explicit disposable-stack opt-in required')
const credentials = JSON.parse(await fs.readFile(process.env.WAKELOGGER_FINISH_CREDENTIALS_FILE, 'utf8'))
assert.ok(['localhost', '127.0.0.1'].includes(credentials.mqttHost), 'only loopback disposable brokers allowed')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finish-cloud-plugin-'))
await new CredentialStore(path.join(directory, 'identity')).save(credentials)
const handlers = new Map()
const instances = []
const start = WakeLoggerTransport.prototype.start
WakeLoggerTransport.prototype.start = function () { instances.push(this); return start.call(this) }
let ingest
let configuration = { uploadMode: 'automatic', samplePeriodMs: 250 }
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
  await until('actual plugin MQTT connection', async () => (await tracking()).connectionState === 'online')
  const transport = instances.at(-1)
  const client = transport.client
  let reconnects = 0
  client.on('connect', () => { reconnects += 1 })
  const terminals = [], statuses = []
  const publish = client.publish
  client.publish = function (topic, payload, ...args) {
    if (topic.endsWith('/status')) terminals.push(...(JSON.parse(String(payload)).recordings || []).filter(entry => entry.state === 'complete'))
    return publish.call(this, topic, payload, ...args)
  }
  client.on('message', (topic, payload) => { if (topic.endsWith('/ack')) statuses.push(...(JSON.parse(String(payload)).recordingStatuses || [])) })
  const startAt = Date.now() - 180_000
  let sequence = 0
  for (let index = 0; index < 6; index += 1) {
    ingest({ updates: [{ timestamp: new Date(startAt + index * 30_000).toISOString(), values: [
      { path: 'navigation.position', value: { latitude: -27.4 + index * .001, longitude: 153.17 + index * .001 } },
      { path: 'navigation.speedOverGround', value: 2 }
    ] }] })
    sequence = await until('real durable telemetry sample', async () => {
      try { const checkpoint = JSON.parse(await fs.readFile(path.join(directory, 'recordings', credentials.deviceId, 'state.json'), 'utf8')); return checkpoint.committed?.sequence > sequence ? checkpoint.committed.sequence : false } catch { return false }
    })
  }
  const active = await tracking()
  assert.ok(active.trackingSessionId)
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  await page.goto(base)
  await page.getByRole('button', { name: 'Finish trip', exact: true }).click()
  await until('immediate actual terminal MQTT publication', () => terminals.find(entry => entry.id === active.trackingSessionId && entry.lastSequence === sequence), 5000)
  await until('same-connection exact cloud readiness', async () => {
    const status = await tracking()
    return status.finishedTrip?.cloudStatus?.state === 'ready' && !status.finishedTrip.confirmationPending ? status : false
  })
  await page.locator('#finished-trip').filter({ hasText: 'confirmed ready by cloud' }).waitFor()
  await page.screenshot({ path: process.env.WAKELOGGER_FINISH_SCREENSHOT || '/tmp/wakelogger-finish-cloud-confirmed.png', fullPage: true })
  assert.equal(reconnects, 0)
  assert.equal(client.connected, true)
  assert.equal(nativeWrites.length, 0)
  const finished = (await tracking()).finishedTrip
  assert.equal(finished.manifest.lastSequence, sequence)
  assert.equal(finished.manifest.endedAt, startAt + 150_000)
  assert.equal(finished.cloudStatus.receivedSamples, 6)
  assert.equal(finished.cloudStatus.missingSamples, 0)
  await page.reload()
  await page.locator('#finished-trip').filter({ hasText: 'confirmed ready by cloud' }).waitFor()
  await plugin.stop(); plugin.start(configuration, () => {})
  await until('ready confirmation persisted across restart', async () => { const status = await tracking(); return status.available && status.connectionState === 'online' && status.finishedTrip?.confirmationPending === false })
  console.log(JSON.stringify({ recordingId: finished.manifest.id, firstSequence: finished.manifest.firstSequence, lastSequence: sequence, samples: 6, endedAt: finished.manifest.endedAt, voyageId: finished.cloudStatus.voyageId, environmentPending: finished.cloudStatus.environmentPending, terminalPublications: terminals.length, cloudStates: [...new Set(statuses.map(entry => entry.state))], reconnectsBeforeConfirmation: reconnects, browserConfirmation: true, restartConfirmation: true }))
} finally {
  await browser?.close(); await plugin.stop(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); WakeLoggerTransport.prototype.start = start
  await fs.rm(directory, { recursive: true, force: true })
}
