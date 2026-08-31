import mqtt, { type MqttClient } from 'mqtt'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileOutbox } from '../../src/outbox/file-outbox'
import { DEFAULT_TELEMETRY_PROFILE } from '../../src/telemetry/profile'
import { WakeLoggerTransport } from '../../src/transport/mqtt-client'

const brokerUrl = process.env.WAKELOGGER_TEST_MQTT_URL
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

describe.skipIf(!brokerUrl)('real MQTT broker transport', () => {
  it('publishes current state first and retains backlog until a real application ACK', async () => {
    const url = new URL(brokerUrl!)
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-broker-'))
    directories.push(directory)
    const outbox = new FileOutbox(directory, {
      maxBytes: 1_000_000,
      maxAgeMs: 86_400_000,
      segmentBytes: 4096
    })
    await outbox.open()
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await outbox.append('dev_broker', {
        capturedAt: sequence * 1000,
        receivedAt: sequence * 1000,
        values: { lat: -27 + sequence / 10_000, lon: 153, sog_kn: 6 },
        quality: { timestamp: 'source' }
      })
    }

    const observed: Array<{ topic: string; payload: string }> = []
    const observer = mqtt.connect(brokerUrl!, { protocolVersion: 5, reconnectPeriod: 0 })
    await connected(observer)
    await subscribed(observer, 'wakelogger/v1/devices/dev_broker/#')
    observer.on('message', (topic, payload) => {
      observed.push({ topic, payload: payload.toString('utf8') })
      if (!topic.endsWith('/telemetry')) return
      const batch = JSON.parse(payload.toString('utf8')) as { samples: Array<{ sequence: number }> }
      const through = batch.samples.at(-1)?.sequence
      if (through) observer.publish(
        'wakelogger/v1/devices/dev_broker/ack',
        JSON.stringify({ v: 1, deviceId: 'dev_broker', ackSequence: through, acknowledgedAt: Date.now() }),
        { qos: 1 }
      )
    })

    const transport = new WakeLoggerTransport({
      version: 1,
      deviceId: 'dev_broker',
      clientId: 'dev_broker',
      username: 'dev_broker',
      password: 'integration-secret',
      mqttHost: url.hostname,
      mqttPort: Number(url.port),
      tls: false,
      pairedAt: Date.now()
    }, outbox, { profile: DEFAULT_TELEMETRY_PROFILE, onState: () => undefined })

    try {
      transport.start()
      await waitFor(async () => (await outbox.stats()).acknowledgedSequence === 3)
      const stateIndex = observed.findIndex((message) => message.topic.endsWith('/state'))
      const telemetryIndex = observed.findIndex((message) => message.topic.endsWith('/telemetry'))
      expect(stateIndex).toBeGreaterThanOrEqual(0)
      expect(stateIndex).toBeLessThan(telemetryIndex)
      expect(JSON.parse(observed[stateIndex]!.payload)).toMatchObject({ sequence: 3 })
      expect(JSON.parse(observed[telemetryIndex]!.payload).samples.map((sample: { sequence: number }) => sample.sequence)).toEqual([1, 2, 3])
      expect(await outbox.stats()).toMatchObject({ acknowledgedSequence: 3, messageCount: 0, droppedCount: 0 })
      expect(transport.transportMetrics().networkMode).toBe('NORMAL')
    } finally {
      await transport.stop()
      await ended(observer)
      await outbox.close()
    }
  }, 15_000)
})

function connected(client: MqttClient): Promise<void> {
  if (client.connected) return Promise.resolve()
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve())
    client.once('error', reject)
  })
}

function subscribed(client: MqttClient, topic: string): Promise<void> {
  return new Promise((resolve, reject) => client.subscribe(topic, { qos: 1 }, (error) => error ? reject(error) : resolve()))
}

function ended(client: MqttClient): Promise<void> {
  return new Promise((resolve) => client.end(false, {}, () => resolve()))
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for broker integration result')
}
