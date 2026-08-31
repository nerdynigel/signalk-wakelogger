import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clients: FakeClient[] = []
const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }))

vi.mock('mqtt', () => ({ default: { connect: connectMock } }))

import { WakeLoggerTransport } from '../../src/transport/mqtt-client'
import { DEFAULT_TELEMETRY_PROFILE } from '../../src/telemetry/profile'

class FakeClient extends EventEmitter {
  connected = true
  publications: Array<{ topic: string; payload: string; options: object }> = []
  subscriptions: string[] = []
  delayNextState = false
  delayNextTelemetry = false
  delayedCallbacks: Array<() => void> = []
  publish(topic: string, payload: string, options: object, callback: (error?: Error) => void): void {
    this.publications.push({ topic, payload, options })
    if ((this.delayNextState && topic.endsWith('/state')) || (this.delayNextTelemetry && topic.endsWith('/telemetry'))) {
      this.delayNextState = false
      this.delayNextTelemetry = false
      this.delayedCallbacks.push(() => callback())
      return
    }
    callback()
  }
  subscribe(topic: string | Record<string, object>, callbackOrOptions: object | ((error?: Error) => void), maybeCallback?: (error?: Error) => void): void {
    this.subscriptions.push(...(typeof topic === 'string' ? [topic] : Object.keys(topic)))
    const callback = typeof callbackOrOptions === 'function' ? callbackOrOptions : maybeCallback
    callback?.()
  }
  end(_force?: boolean, _options?: object, callback?: (error?: Error) => void): void {
    this.connected = false; callback?.()
  }
  releasePublish(): void { this.delayedCallbacks.shift()?.() }
}

const sample: any = {
  v: 1, deviceId: 'dev_1', sequence: 1, capturedAt: 1000, receivedAt: 1000,
  values: {
    lat: -27, lon: 153, sog_kn: 6.4, cog_deg: 241.3, heading_deg: 238.8,
    heading_reference: 'true', depth_m: 12.4, aws_kn: 15.2, awa_deg: 315
  }, quality: { timestamp: 'source' }
}

beforeEach(() => {
  clients.splice(0)
  connectMock.mockReset()
  connectMock.mockImplementation(() => {
    const client = new FakeClient()
    clients.push(client)
    return client
  })
})
afterEach(() => vi.useRealTimers())

describe('WakeLoggerTransport', () => {
  it('uses MQTT 5 verified TLS, prioritises current state and applies cloud acknowledgements', async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined)
    const outbox: any = {
      latest: vi.fn().mockResolvedValue(sample),
      pendingAfter: vi.fn().mockResolvedValue([sample]),
      stats: vi.fn().mockResolvedValue({ acknowledgedSequence: 0, droppedThrough: 0 }),
      acknowledge
    }
    const states: string[] = []
    const transport = new WakeLoggerTransport({
      version: 1, deviceId: 'dev_1', clientId: 'client_1', username: 'dev_1',
      password: 'a-very-long-secret', mqttHost: 'broker.example.invalid', mqttPort: 8883, tls: true, pairedAt: 1000
    }, outbox, { profile: DEFAULT_TELEMETRY_PROFILE, onState: (state) => states.push(state) })
    transport.start()
    await tick()
    expect(connectMock).toHaveBeenCalledWith('mqtts://broker.example.invalid:8883', expect.objectContaining({
      protocolVersion: 5, rejectUnauthorized: true, minVersion: 'TLSv1.2', reconnectPeriod: 0
    }))
    const client = clients[0]!
    client.emit('connect')
    await tick(); await tick()
    transport.updateStatus({
      pluginVersion: '0.1.0', connectionState: 'online', queueMessageCount: 3,
      queueDiskBytes: 4096, queueOldestCapturedAt: 1000, queueDroppedCount: 2,
      acknowledgedSequence: 1, currentSequence: 4, trackingState: 'moving'
    })
    await tick()
    expect(client.subscriptions).toContain('wakelogger/v1/devices/dev_1/ack')
    const topics = client.publications.map((entry) => entry.topic)
    expect(topics.indexOf('wakelogger/v1/devices/dev_1/state')).toBeLessThan(topics.indexOf('wakelogger/v1/devices/dev_1/telemetry'))
    const telemetry = JSON.parse(client.publications.find((entry) => entry.topic.endsWith('/telemetry'))!.payload)
    expect(telemetry.samples[0].values).toEqual(sample.values)
    client.emit('message', 'wakelogger/v1/devices/dev_1/ack', Buffer.from('{"v":1,"deviceId":"dev_1","ackSequence":1,"acknowledgedAt":2000}'))
    await tick()
    expect(acknowledge).toHaveBeenCalledWith(1)
    expect(states).toContain('online')
    const status = JSON.parse(client.publications.filter((entry) => entry.topic.endsWith('/status')).at(-1)!.payload)
    expect(status).toMatchObject({ pluginVersion: '0.1.0', queueMessageCount: 3, queueDiskBytes: 4096, queueDroppedCount: 2 })

    client.delayNextState = true
    transport.updateCurrent({ ...sample, sequence: 2 })
    transport.updateCurrent({ ...sample, sequence: 3 })
    await tick()
    const delayedStateCount = client.publications.filter((entry) => entry.topic.endsWith('/state')).length
    expect(delayedStateCount).toBe(2)
    client.releasePublish()
    await tick()
    const statePayloads = client.publications.filter((entry) => entry.topic.endsWith('/state')).map((entry) => JSON.parse(entry.payload))
    expect(statePayloads.at(-1).sequence).toBe(3)
    await transport.stop()
  })

  it('serializes slow telemetry publications and retries auth failures at a long interval', async () => {
    vi.useFakeTimers()
    const outbox: any = {
      latest: vi.fn().mockResolvedValue(sample), pendingAfter: vi.fn().mockResolvedValue([sample]),
      stats: vi.fn().mockResolvedValue({ acknowledgedSequence: 0, droppedThrough: 0 }), acknowledge: vi.fn()
    }
    const transport = new WakeLoggerTransport({
      version: 1, deviceId: 'dev_1', clientId: 'client_1', username: 'dev_1', password: 'a-very-long-secret',
      mqttHost: 'broker.example.invalid', mqttPort: 8883, tls: true, pairedAt: 1000
    }, outbox, { profile: DEFAULT_TELEMETRY_PROFILE, onState: vi.fn(), random: () => 0 })
    transport.start()
    await Promise.resolve(); await Promise.resolve()
    const client = clients[0]!
    client.delayNextTelemetry = true
    client.emit('connect')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    void (transport as any).pump(); void (transport as any).pump()
    await Promise.resolve(); await Promise.resolve()
    expect(outbox.pendingAfter).toHaveBeenCalledTimes(1)
    client.releasePublish()
    await Promise.resolve(); await Promise.resolve()

    client.emit('error', new Error('Not authorized'))
    client.emit('close')
    await vi.advanceTimersByTimeAsync(225_001)
    expect(connectMock).toHaveBeenCalledTimes(2)
    await transport.stop()
  })

  it('applies a retained managed profile and reports the revision result', async () => {
    const outbox: any = {
      latest: vi.fn().mockResolvedValue(undefined), pendingAfter: vi.fn().mockResolvedValue([]),
      stats: vi.fn().mockResolvedValue({ acknowledgedSequence: 0, droppedThrough: 0 }), acknowledge: vi.fn()
    }
    const onProfile = vi.fn().mockResolvedValue(undefined)
    const transport = new WakeLoggerTransport({
      version: 1, deviceId: 'dev_1', clientId: 'client_1', username: 'dev_1', password: 'a-very-long-secret',
      mqttHost: 'broker.example.invalid', mqttPort: 8883, tls: true, pairedAt: 1000
    }, outbox, { profile: DEFAULT_TELEMETRY_PROFILE, onState: vi.fn(), onProfile })
    transport.start(); await tick()
    const client = clients[0]!
    client.emit('connect'); await tick(); await tick()
    const replacement = structuredClone(DEFAULT_TELEMETRY_PROFILE)
    replacement.profileId = 'coastal'
    replacement.revision = 2
    replacement.issuedAt = 2000
    replacement.paths.depth.enabled = false
    client.emit('message', 'wakelogger/v1/devices/dev_1/profile', Buffer.from(JSON.stringify(replacement)))
    await tick(); await tick()
    expect(onProfile).toHaveBeenCalledWith(replacement)
    const acknowledgement = JSON.parse(client.publications.filter((entry) => entry.topic.endsWith('/profile-ack')).at(-1)!.payload)
    expect(acknowledgement).toMatchObject({ profileId: 'coastal', revision: 2, status: 'applied' })
    await transport.stop()
  })

  it('prioritises current/live data while draining an outage backlog only after durable ACK', async () => {
    let now = 1_000
    let acknowledged = 0
    const history = Array.from({ length: 3600 }, (_, index) => ({
      ...sample,
      sequence: index + 1,
      capturedAt: index * 1000,
      receivedAt: index * 1000
    }))
    const pendingAfter = vi.fn(async (after: number, limit: number, maxBytes: number) => {
      const result: any[] = []
      let bytes = 0
      for (const item of history) {
        if (item.sequence <= Math.max(after, acknowledged)) continue
        const size = Buffer.byteLength(JSON.stringify(item))
        if (result.length && (result.length >= limit || bytes + size > maxBytes)) break
        result.push(item)
        bytes += size
      }
      return result
    })
    const acknowledge = vi.fn(async (sequence: number) => { acknowledged = Math.max(acknowledged, sequence) })
    const outbox: any = {
      latest: vi.fn(async () => history.at(-1)),
      pendingAfter,
      stats: vi.fn(async () => ({
        messageCount: history.filter((item) => item.sequence > acknowledged).length,
        acknowledgedSequence: acknowledged,
        currentSequence: history.at(-1)?.sequence ?? 0,
        droppedThrough: 0
      })),
      acknowledge
    }
    const transport = new WakeLoggerTransport({
      version: 1, deviceId: 'dev_1', clientId: 'client_1', username: 'dev_1', password: 'a-very-long-secret',
      mqttHost: 'broker.example.invalid', mqttPort: 8883, tls: true, pairedAt: 1000
    }, outbox, { profile: DEFAULT_TELEMETRY_PROFILE, onState: vi.fn(), now: () => now })
    transport.start(); await tick()
    const client = clients[0]!
    client.emit('connect'); await tick(); await tick()

    const stateIndex = client.publications.findIndex((entry) => entry.topic.endsWith('/state'))
    const backlogIndex = client.publications.findIndex((entry) => entry.topic.endsWith('/telemetry'))
    expect(stateIndex).toBeGreaterThanOrEqual(0)
    expect(stateIndex).toBeLessThan(backlogIndex)
    expect(acknowledged).toBe(0)

    now = 3_601_000
    const live = { ...sample, sequence: 3601, capturedAt: now, receivedAt: now }
    history.push(live)
    transport.updateCurrent(live)
    await tick(); await tick()
    const telemetryPayloads = client.publications
      .filter((entry) => entry.topic.endsWith('/telemetry'))
      .map((entry) => JSON.parse(entry.payload))
    expect(telemetryPayloads.some((batch) => batch.samples.length === 1 && batch.samples[0].sequence === 3601)).toBe(true)
    expect(telemetryPayloads.some((batch) => batch.samples[0].sequence === 1)).toBe(true)

    client.emit('error', new Error('connection reset'))
    expect(transport.transportMetrics()).toMatchObject({ networkMode: 'CONSTRAINED', modeReason: 'mqtt_error' })
    client.emit('message', 'wakelogger/v1/devices/dev_1/ack', Buffer.from('{"v":1,"deviceId":"dev_1","ackSequence":60}'))
    await tick(); await tick()
    expect(acknowledge).toHaveBeenCalledWith(60)
    expect(acknowledged).toBe(60)
    expect(pendingAfter.mock.calls.some((call) => call[0] >= 60 && call[2] === 8192)).toBe(true)
    const callsAtExhaustion = pendingAfter.mock.calls.length
    await (transport as any).pump()
    expect(pendingAfter).toHaveBeenCalledTimes(callsAtExhaustion)
    now += 1000
    await (transport as any).pump()
    expect(pendingAfter.mock.calls.length).toBeGreaterThan(callsAtExhaustion)
    await transport.stop()
  })
})

async function tick(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)) }
