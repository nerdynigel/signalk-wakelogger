import mqtt, { type IClientOptions, type MqttClient } from 'mqtt'
import type { DeviceCredentials } from '../pairing/credentials'
import { parseTelemetryProfile, type ProfileAcknowledgement, type TelemetryProfile } from '../telemetry/profile'
import type { ApplicationAck, NetworkMode, PluginStatusMetrics, TelemetryBatch, TelemetrySample } from '../telemetry/types'
import type { OutboxStore } from '../outbox/interface'
import { AdaptiveModeMonitor } from './adaptive-mode'
import { deviceTopics } from './topics'

export type ConnectionState = 'offline' | 'connecting' | 'online' | 'degraded' | 'authentication_failed'

interface TransportOptions {
  profile: TelemetryProfile
  onState: (state: ConnectionState, detail?: string) => void
  onMode?: (mode: NetworkMode, reason: string) => void
  onProfile?: (profile: TelemetryProfile) => Promise<void>
  debug?: (message: string) => void
  random?: () => number
  now?: () => number
}

interface InFlightBatch { through: number; sentAt: number }

export class WakeLoggerTransport {
  private client?: MqttClient
  private stopped = true
  private reconnectAttempt = 0
  private reconnectTimer?: NodeJS.Timeout
  private pumpTimer?: NodeJS.Timeout
  private healthTimer?: NodeJS.Timeout
  private pumpRunning = false
  private current?: TelemetrySample
  private statePublishInFlight = false
  private statePublishPending = false
  private authenticationFailed = false
  private statusMetrics?: PluginStatusMetrics
  private profile: TelemetryProfile
  private readonly monitor: AdaptiveModeMonitor
  private readonly topics
  private inFlight: InFlightBatch[] = []
  private nextPublishAfter = 0
  private lastLivePublishedAt = 0
  private lastLivePublishedSequence = 0
  private lastAcknowledgedAt?: number
  private acknowledgementLatencyMs?: number
  private publishedBytes = 0
  private lastMode?: NetworkMode
  private backlogMessageCount = 0
  private backlogTokens = 0
  private backlogTokenAt?: number

  constructor(private readonly credentials: DeviceCredentials, private readonly outbox: OutboxStore, private readonly options: TransportOptions) {
    this.topics = deviceTopics(credentials.deviceId)
    this.profile = options.profile
    this.monitor = new AdaptiveModeMonitor(() => this.now())
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.healthTimer = setInterval(() => {
      this.monitor.tick()
      this.syncMode()
      void this.checkAcknowledgementTimeout()
    }, 5000)
    void this.outbox.latest().then((sample) => {
      if (this.stopped) return
      this.current = sample
      this.connect()
    }).catch((error) => this.options.onState('degraded', sanitizeError(String(error))))
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pumpTimer) clearInterval(this.pumpTimer)
    if (this.healthTimer) clearInterval(this.healthTimer)
    const client = this.client
    this.client = undefined
    this.monitor.disconnected('plugin_stopped')
    this.syncMode()
    if (!client) return
    if (client.connected) await this.publish(client, this.topics.status, JSON.stringify(statusPayload('offline', this.effectiveStatusMetrics())), { qos: 1, retain: true }).catch(() => undefined)
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()))
  }

  updateCurrent(sample: TelemetrySample): void {
    this.current = sample
    this.statePublishPending = true
    if (this.client?.connected) {
      void this.drainCurrentState().catch((error) => this.transportFailure(error))
      void this.publishLiveSample().catch((error) => this.transportFailure(error))
    }
  }

  updateProfile(profile: TelemetryProfile): void { this.profile = profile }

  updateStatus(metrics: PluginStatusMetrics): void {
    this.statusMetrics = metrics
    if (this.client?.connected) {
      void this.publish(this.client, this.topics.status, JSON.stringify(statusPayload(metrics.connectionState, this.effectiveStatusMetrics())), { qos: 1, retain: true })
        .catch((error) => this.transportFailure(error))
    }
  }

  transportMetrics(): Pick<PluginStatusMetrics, 'networkMode' | 'modeReason' | 'lastAcknowledgedAt' | 'acknowledgementLatencyMs' | 'reconnectCount' | 'publishedBytes'> {
    const health = this.monitor.current()
    return { networkMode: health.mode, modeReason: health.reason, lastAcknowledgedAt: this.lastAcknowledgedAt,
      acknowledgementLatencyMs: this.acknowledgementLatencyMs, reconnectCount: health.reconnectCount, publishedBytes: this.publishedBytes }
  }

  private connect(): void {
    if (this.stopped) return
    this.options.onState('connecting')
    this.authenticationFailed = false
    const scheme = this.credentials.tls ? 'mqtts' : 'mqtt'
    const url = `${scheme}://${this.credentials.mqttHost}:${this.credentials.mqttPort}`
    const mqttOptions: IClientOptions = {
      protocolVersion: 5, clean: false, reconnectPeriod: 0, connectTimeout: 15_000,
      ...(this.credentials.tls ? { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const } : {}), clientId: this.credentials.clientId,
      username: this.credentials.username, password: this.credentials.password,
      properties: { sessionExpiryInterval: 24 * 60 * 60 },
      will: { topic: this.topics.status, payload: Buffer.from(JSON.stringify(statusPayload('offline'))), qos: 1, retain: true }
    }
    const client = mqtt.connect(url, mqttOptions)
    this.client = client
    client.on('connect', () => void this.onConnect(client).catch((error) => { this.transportFailure(error); client.end(true) }))
    client.on('message', (topic, payload) => void this.onMessage(topic, payload))
    client.on('error', (error) => {
      const auth = /auth|not authorized|bad user/i.test(error.message)
      this.authenticationFailed = auth
      if (auth) this.monitor.disconnected('authentication_failed')
      else this.monitor.failure('mqtt_error')
      this.syncMode()
      this.options.onState(auth ? 'authentication_failed' : 'degraded', sanitizeError(error.message))
    })
    client.on('close', () => {
      if (client !== this.client || this.stopped) return
      this.monitor.disconnected(this.authenticationFailed ? 'authentication_failed' : 'mqtt_disconnected')
      this.syncMode()
      if (this.authenticationFailed) this.scheduleReconnect(true)
      else { this.options.onState('offline'); this.scheduleReconnect() }
    })
  }

  private async onConnect(client: MqttClient): Promise<void> {
    if (client !== this.client || this.stopped) return
    this.reconnectAttempt = 0
    this.inFlight = []
    const stats = await this.outbox.stats()
    this.backlogMessageCount = stats.messageCount
    this.nextPublishAfter = stats.acknowledgedSequence
    await subscribe(client, [this.topics.ack, this.topics.profile])
    this.monitor.connected()
    this.syncMode()
    this.backlogTokenAt = this.now()
    this.backlogTokens = this.profile.transport.normalBacklogBytesPerSecond
    await this.publish(client, this.topics.status, JSON.stringify(statusPayload('online', this.effectiveStatusMetrics())), { qos: 1, retain: true })
    this.statePublishPending = this.current !== undefined
    await this.drainCurrentState()
    this.options.onState('online')
    if (this.pumpTimer) clearInterval(this.pumpTimer)
    this.pumpTimer = setInterval(() => void this.pump(), 1000)
    void this.pump()
  }

  private async drainCurrentState(): Promise<void> {
    if (this.statePublishInFlight) return
    this.statePublishInFlight = true
    try {
      while (this.statePublishPending && this.current && this.client?.connected && !this.stopped) {
        this.statePublishPending = false
        await this.publish(this.client, this.topics.state, JSON.stringify(this.current), { qos: 1, retain: true })
      }
    } finally { this.statePublishInFlight = false }
  }

  private async publishLiveSample(): Promise<void> {
    const client = this.client
    const current = this.current
    if (!client?.connected || !current || this.backlogMessageCount <= 1 || current.sequence <= this.lastLivePublishedSequence || this.now() - this.lastLivePublishedAt < 1000) return
    const batch: TelemetryBatch = { v: 1, deviceId: this.credentials.deviceId, samples: [current] }
    await this.publish(client, this.topics.telemetry, JSON.stringify(batch), { qos: 1 })
    this.lastLivePublishedAt = this.now()
    this.lastLivePublishedSequence = current.sequence
  }

  private async pump(): Promise<void> {
    const client = this.client
    if (!client?.connected || this.stopped || this.pumpRunning || this.inFlight.length >= 4) return
    this.pumpRunning = true
    try {
      const health = this.monitor.current()
      const byteRate = health.mode === 'CONSTRAINED' ? this.profile.transport.constrainedBacklogBytesPerSecond : this.profile.transport.normalBacklogBytesPerSecond
      const budget = this.refillBacklogBudget(byteRate)
      if (budget < 512) return
      const samples = await this.outbox.pendingAfter(this.nextPublishAfter, this.profile.transport.batchSize, Math.min(budget, this.profile.transport.maxPayloadBytes - 1024))
      if (!samples.length) return
      const stats = await this.outbox.stats()
      this.backlogMessageCount = stats.messageCount
      const batch: TelemetryBatch = { v: 1, deviceId: this.credentials.deviceId,
        droppedThrough: stats.droppedThrough > stats.acknowledgedSequence ? stats.droppedThrough : undefined, samples }
      const payload = JSON.stringify(batch)
      if (Buffer.byteLength(payload) > this.profile.transport.maxPayloadBytes) throw new Error('Telemetry batch exceeds payload limit')
      for (const sample of samples) if (sample.evidence) {
        await this.publish(client, this.topics.events, JSON.stringify({ v: 1, deviceId: sample.deviceId, sequence: sample.sequence, ...sample.evidence }), { qos: 1 })
      }
      await this.publish(client, this.topics.telemetry, payload, { qos: 1 })
      this.backlogTokens -= Buffer.byteLength(payload)
      const through = samples.at(-1)?.sequence ?? this.nextPublishAfter
      this.inFlight.push({ through, sentAt: this.now() })
      this.nextPublishAfter = through
    } catch (error) { this.transportFailure(error) }
    finally { this.pumpRunning = false }
  }

  private async onMessage(topic: string, payload: Buffer): Promise<void> {
    if (topic === this.topics.ack) await this.handleAcknowledgement(payload)
    else if (topic === this.topics.profile) await this.handleProfile(payload)
  }

  private async handleAcknowledgement(payload: Buffer): Promise<void> {
    if (payload.length > 4096) return
    try {
      const ack = JSON.parse(payload.toString('utf8')) as ApplicationAck
      if (ack.v !== 1 || ack.deviceId !== this.credentials.deviceId || !Number.isSafeInteger(ack.ackSequence)) return
      const acknowledgedBatch = this.inFlight.find((batch) => ack.ackSequence >= batch.through)
      if (acknowledgedBatch) {
        this.acknowledgementLatencyMs = this.now() - acknowledgedBatch.sentAt
        this.monitor.acknowledgement(this.acknowledgementLatencyMs)
      }
      await this.outbox.acknowledge(ack.ackSequence)
      this.backlogMessageCount = (await this.outbox.stats()).messageCount
      this.lastAcknowledgedAt = this.now()
      this.inFlight = this.inFlight.filter((batch) => batch.through > ack.ackSequence)
      this.syncMode()
      this.options.debug?.(`Application acknowledged telemetry through sequence ${ack.ackSequence}`)
      void this.pump()
    } catch {
      this.monitor.failure('invalid_acknowledgement'); this.syncMode()
      this.options.onState('degraded', 'Invalid application acknowledgement')
    }
  }

  private async handleProfile(payload: Buffer): Promise<void> {
    let acknowledgement: ProfileAcknowledgement
    try {
      if (payload.length > 16_384) throw new Error('profile_too_large')
      const profile = parseTelemetryProfile(JSON.parse(payload.toString('utf8')))
      if (!profile) throw new Error('profile_invalid')
      if (profile.revision < this.profile.revision) throw new Error('profile_revision_rollback')
      await this.options.onProfile?.(profile)
      this.profile = profile
      acknowledgement = { v: 1, profileId: profile.profileId, revision: profile.revision, status: 'applied', at: this.now() }
    } catch (error) {
      const candidate = safeProfileIdentity(payload)
      acknowledgement = { v: 1, profileId: candidate.profileId, revision: candidate.revision, status: 'rejected', at: this.now(), errorCode: sanitizeProfileError(error) }
    }
    if (this.client?.connected) await this.publish(this.client, this.topics.profileAck, JSON.stringify(acknowledgement), { qos: 1, retain: true })
  }

  private async checkAcknowledgementTimeout(): Promise<void> {
    const oldest = this.inFlight[0]
    if (!oldest || this.now() - oldest.sentAt < 30_000) return
    this.monitor.failure('acknowledgement_timeout')
    this.syncMode()
    const stats = await this.outbox.stats()
    this.inFlight = []
    this.nextPublishAfter = stats.acknowledgedSequence
    void this.pump()
  }

  private scheduleReconnect(authenticationFailure = false): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.monitor.reconnect()
    this.syncMode()
    const base = authenticationFailure ? 5 * 60_000 : Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 6))
    const random = this.options.random?.() ?? Math.random()
    const delay = Math.round(base * (0.75 + random * 0.5))
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => { this.client?.end(true); this.connect() }, delay)
  }

  private syncMode(): void {
    const health = this.monitor.current()
    if (health.mode !== this.lastMode) { this.lastMode = health.mode; this.options.onMode?.(health.mode, health.reason) }
  }

  private effectiveStatusMetrics(): PluginStatusMetrics | undefined {
    return this.statusMetrics ? { ...this.statusMetrics, ...this.transportMetrics(), profileId: this.profile.profileId, profileRevision: this.profile.revision } : undefined
  }

  private transportFailure(error: unknown): void {
    this.monitor.failure('publish_failure')
    this.syncMode()
    this.options.onState('degraded', sanitizeError(error instanceof Error ? error.message : String(error)))
  }

  private async publish(client: MqttClient, topic: string, payload: string, options: { qos: 1; retain?: boolean }): Promise<void> {
    await publish(client, topic, payload, options)
    this.publishedBytes += Buffer.byteLength(payload)
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  private refillBacklogBudget(byteRate: number): number {
    const now = this.now()
    const elapsed = this.backlogTokenAt === undefined ? 0 : Math.max(0, now - this.backlogTokenAt)
    this.backlogTokenAt = now
    this.backlogTokens = Math.min(byteRate, this.backlogTokens + elapsed * byteRate / 1000)
    return Math.max(0, Math.floor(this.backlogTokens))
  }
}

function statusPayload(state: string, metrics?: PluginStatusMetrics): object {
  return { v: 1, state, at: Date.now(), ...(metrics ? {
    pluginVersion: metrics.pluginVersion, queueMessageCount: metrics.queueMessageCount, queueDiskBytes: metrics.queueDiskBytes,
    queueOldestCapturedAt: metrics.queueOldestCapturedAt, queueDroppedCount: metrics.queueDroppedCount,
    acknowledgedSequence: metrics.acknowledgedSequence, currentSequence: metrics.currentSequence, trackingState: metrics.trackingState,
    storageBackend: metrics.storageBackend, networkMode: metrics.networkMode, modeReason: metrics.modeReason,
    profileId: metrics.profileId, profileRevision: metrics.profileRevision, lastAcknowledgedAt: metrics.lastAcknowledgedAt,
    acknowledgementLatencyMs: metrics.acknowledgementLatencyMs, reconnectCount: metrics.reconnectCount, publishedBytes: metrics.publishedBytes
  } : {}) }
}

function safeProfileIdentity(payload: Buffer): { profileId: string; revision: number } {
  try {
    const value = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    return { profileId: typeof value.profileId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.profileId) ? value.profileId : 'unknown',
      revision: Number.isSafeInteger(value.revision) && Number(value.revision) > 0 ? Number(value.revision) : 1 }
  } catch { return { profileId: 'unknown', revision: 1 } }
}
function sanitizeProfileError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return ['profile_too_large', 'profile_invalid', 'profile_revision_rollback'].includes(value) ? value : 'profile_apply_failed'
}
function sanitizeError(value: string): string { return value.replace(/(password|token|secret)=\S+/gi, '$1=[redacted]').slice(0, 500) }
function publish(client: MqttClient, topic: string, payload: string, options: { qos: 1; retain?: boolean }): Promise<void> {
  return new Promise((resolve, reject) => client.publish(topic, payload, options, (error) => error ? reject(error) : resolve()))
}
function subscribe(client: MqttClient, topics: string[]): Promise<void> {
  const subscriptions = Object.fromEntries(topics.map((topic) => [topic, { qos: 1 as const }]))
  return new Promise((resolve, reject) => client.subscribe(subscriptions, (error) => error ? reject(error) : resolve()))
}
