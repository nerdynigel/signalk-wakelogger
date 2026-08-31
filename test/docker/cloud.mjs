import { promises as fs, readFileSync } from 'node:fs'
import https from 'node:https'
import mqtt from 'mqtt'

const certDirectory = '/certs'
const deviceId = 'dev_docker_e2e'
const baseTopic = `wakelogger/v1/devices/${deviceId}`
const pairingCode = 'docker-e2e-pairing-code'
const eventFile = '/data/events.jsonl'
const maximumEvents = 2_000
let mqttConnected = false
let mqttSubscribed = false
let pairingCount = 0
let persistedCount = 0
let events = []
let processing = Promise.resolve()
const maximumAcknowledged = new Map()

await fs.mkdir('/data', { recursive: true })
try {
  const existing = await fs.readFile(eventFile, 'utf8')
  persistedCount = existing.split('\n').filter(Boolean).length
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const ca = readFileSync(`${certDirectory}/ca.crt`)
const client = mqtt.connect('mqtts://mosquitto:8883', {
  protocolVersion: 5,
  clientId: 'wakelogger-docker-e2e-cloud',
  clean: true,
  reconnectPeriod: 250,
  connectTimeout: 5_000,
  ca,
  rejectUnauthorized: true,
  minVersion: 'TLSv1.2'
})

client.on('connect', () => {
  mqttConnected = true
  client.subscribe('wakelogger/v1/devices/+/+', { qos: 1 }, (error) => {
    if (error) process.stderr.write(`Unable to subscribe: ${error.message}\n`)
    else mqttSubscribed = true
  })
})
client.on('close', () => { mqttConnected = false; mqttSubscribed = false })
client.on('error', (error) => process.stderr.write(`MQTT client error: ${error.message}\n`))
client.on('message', (topic, payload) => {
  processing = processing.then(() => processMessage(topic, payload)).catch((error) => {
    process.stderr.write(`Message processing error: ${error instanceof Error ? error.message : String(error)}\n`)
  })
})

async function processMessage(topic, payloadBuffer) {
  if (payloadBuffer.length > 128 * 1024) return
  let payload
  try { payload = JSON.parse(payloadBuffer.toString('utf8')) }
  catch { return }
  const event = { ordinal: persistedCount + 1, receivedAt: Date.now(), topic, payload }
  await durableAppend(event)
  persistedCount += 1
  events.push(event)
  if (events.length > maximumEvents) events = events.slice(-maximumEvents)
  if (topic !== `${baseTopic}/telemetry` || !Array.isArray(payload?.samples)) return
  const sequences = payload.samples.map((sample) => sample?.sequence).filter(Number.isSafeInteger)
  const through = sequences.length ? Math.max(...sequences) : undefined
  if (through === undefined) return
  const prior = maximumAcknowledged.get(deviceId) ?? 0
  await publish(`${baseTopic}/ack`, JSON.stringify({ v: 1, deviceId, ackSequence: through, acknowledgedAt: Date.now() }))
  maximumAcknowledged.set(deviceId, Math.max(prior, through))
}

async function durableAppend(value) {
  const handle = await fs.open(eventFile, 'a', 0o600)
  try {
    await handle.write(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function publish(topic, payload) {
  return new Promise((resolve, reject) => client.publish(topic, payload, { qos: 1 }, (error) => error ? reject(error) : resolve()))
}

const server = https.createServer({
  key: readFileSync(`${certDirectory}/server.key`),
  cert: readFileSync(`${certDirectory}/server.crt`)
}, async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const ready = mqttConnected && mqttSubscribed
      return json(response, ready ? 200 : 503, { ok: ready, mqttConnected, mqttSubscribed })
    }
    if (request.method === 'GET' && request.url === '/snapshot') {
      await processing
      return json(response, 200, {
        mqttConnected,
        mqttSubscribed,
        pairingCount,
        persistedCount,
        maximumAcknowledged: Object.fromEntries(maximumAcknowledged),
        events
      })
    }
    if (request.method === 'POST' && request.url === '/events/reset') {
      await processing
      events = []
      return json(response, 200, { reset: true, persistedCount })
    }
    if (request.method === 'POST' && request.url === '/pair') {
      const body = await readJson(request)
      if (body?.code !== pairingCode) return json(response, 401, { detail: 'invalid_pairing_code' })
      pairingCount += 1
      return json(response, 201, {
        device: { id: deviceId },
        credentials: {
          broker_host: 'mosquitto',
          broker_port: 8883,
          tls: true,
          client_id: deviceId,
          username: deviceId,
          password: 'docker-e2e-password-0001'
        }
      })
    }
    return json(response, 404, { detail: 'not_found' })
  } catch (error) {
    return json(response, 500, { detail: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(8443, '0.0.0.0')

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16_384) throw new Error('request_too_large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function shutdown() {
  server.close()
  await new Promise((resolve) => client.end(false, {}, resolve))
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
