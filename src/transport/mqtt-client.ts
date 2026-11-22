import type { CourseAcknowledgement } from '../courses/protocol'
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt'
import type { DeviceCredentials } from '../pairing/credentials'
import type { RacePackAck } from '../race/race-pack-protocol'
import { parseTelemetryProfile, type ProfileAcknowledgement, type TelemetryProfile } from '../telemetry/profile'
import type { ApplicationAck, RecordingAcknowledgement, RecordingStatus, NetworkMode, PluginStatusMetrics, TelemetryBatch, TelemetrySample } from '../telemetry/types'
import type { OutboxStore } from '../outbox/interface'
import { AdaptiveModeMonitor } from './adaptive-mode'
import { deviceTopics } from './topics'

export type ConnectionState = 'offline' | 'connecting' | 'online' | 'degraded' | 'authentication_failed'

interface TransportOptions {
  profile: TelemetryProfile
  uploadDisposition?: (sample: TelemetrySample) => 'upload' | 'skip' | 'wait'
  onState: (state: ConnectionState, detail?: string) => void
  onMode?: (mode: NetworkMode, reason: string) => void
  onCourse?: (payload: Buffer) => Promise<CourseAcknowledgement>
  getCourseAcknowledgement?: () => Promise<CourseAcknowledgement | undefined> | CourseAcknowledgement | undefined
  onRacePackManifest?: (payload: Buffer) => Promise<RacePackAck | null>
  onRacePackChunk?: (payload: Buffer, topicIndex: number) => Promise<RacePackAck | null>
  getRacePackAck?: () => RacePackAck | null
  onRecordingStatuses?: (statuses: RecordingStatus[]) => Promise<void>
  onRecordingAcks?: (acks: RecordingAcknowledgement[]) => Promise<void>
  onRacePlanSnapshotAcks?: (ids: string[]) => Promise<void>
  onProfile?: (profile: TelemetryProfile) => Promise<void>
  debug?: (message: string) => void
  random?: () => number
  now?: () => number
}

interface InFlightBatch { first: number; through: number; sentAt: number; lastSentAt: number; retry?: boolean; timeoutMs?: number; retryAfter?: number; selectionMs?: number; brokerAt?: number; publishStartedAt?: number }

export class WakeLoggerTransport {
  private client?: MqttClient
  private stopped = true
  private lifecycle = 0
  private supportsTripPolicy = false
  private reconnectAttempt = 0
  private reconnectTimer?: NodeJS.Timeout
  private pumpTimer?: NodeJS.Timeout
  private healthTimer?: NodeJS.Timeout
  private pumpRunning?: MqttClient
  private current?: TelemetrySample
  private statePublishInFlight?: MqttClient
  private statePublishPending = false
  private authenticationFailed = false
  private courseSubscriptionError?: string
  private racePackSubscriptionError?: string
  private statusMetrics?: PluginStatusMetrics
  private profile: TelemetryProfile
  private readonly monitor: AdaptiveModeMonitor
  private readonly topics
  private inFlight: InFlightBatch[] = []
  private nextPublishAfter = 0
  private optionalCoursePending = false
  private optionalCourseAt = -Infinity
  private lastLivePublishedAt = 0
  private lastLivePublishedSequence = 0
  private lastAcknowledgedAt?: number
  private acknowledgementLatencyMs?: number
  private uploadTiming?: { selectionMs: number; brokerMs: number | null; receiptMs: number; persistenceMs: number; durableMs: number }
  uploadTimings(): typeof this.uploadTiming { return this.uploadTiming ? { ...this.uploadTiming } : undefined }
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
    const lifecycle = ++this.lifecycle
    this.healthTimer = setInterval(() => {
      this.monitor.tick()
      this.syncMode()
      void this.checkAcknowledgementTimeout()
      void this.syncOptionalCourse()
    }, 5000)
    void this.outbox.latest().then((sample) => {
      if (this.stopped || lifecycle !== this.lifecycle) return
      this.current = sample && this.canUpload(sample) ? sample : undefined
      this.connect()
    }).catch((error) => this.options.onState('degraded', sanitizeError(String(error))))
  }

  // Shutdown is an explicit pair of decisions. A graceful end sends an MQTT
  // DISCONNECT (suppressing the Last Will); force closes the socket without a
  // DISCONNECT so the retained Last Will fires. They are independent of whether
  // an ordinary retained offline status is published first.
  async stop(options: { publishOffline?: boolean; force?: boolean } = {}): Promise<void> {
    const publishOffline = options.publishOffline ?? true
    const force = options.force ?? false
    this.stopped = true
    this.lifecycle += 1
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pumpTimer) clearInterval(this.pumpTimer)
    if (this.healthTimer) clearInterval(this.healthTimer)
    const client = this.client
    this.client = undefined
    this.monitor.disconnected('plugin_stopped')
    this.syncMode()
    if (!client) return
    if (publishOffline && !force && client.connected) await publish(client, this.topics.status, JSON.stringify(statusPayload('offline', this.effectiveStatusMetrics())), { qos: 1, retain: true }).catch(() => undefined)
    await new Promise<void>((resolve) => client.end(force, {}, () => resolve()))
  }

  private canUpload(sample: TelemetrySample): boolean {
    return !this.options.uploadDisposition || this.options.uploadDisposition(sample) === 'upload'
  }

  updateCurrent(sample: TelemetrySample): void {
    if (!this.canUpload(sample)) return
    this.current = sample
    this.statePublishPending = true
    if (this.client?.connected) {
      void this.drainCurrentState().catch((error) => this.transportFailure(error))
      void this.publishLiveSample().catch((error) => this.transportFailure(error))
    }
  }

  async publishCourseAcknowledgement(): Promise<void> {
    const client = this.client
    if (this.courseSubscriptionError || !client?.connected || this.stopped) return
    const acknowledgement = await bounded(Promise.resolve().then(() => this.options.getCourseAcknowledgement?.()))
    if (acknowledgement && client === this.client && client.connected && !this.stopped) {
      await this.publish(client, this.topics.courseAck, JSON.stringify(acknowledgement), { qos: 1, retain: true })
    }
  }

  private async syncOptionalCourse(): Promise<void> {
    const client = this.client
    if (this.stopped || !client?.connected || this.optionalCoursePending || this.now() - this.optionalCourseAt < 30_000) return
    this.optionalCoursePending = true
    this.optionalCourseAt = this.now()
    try {
      await bounded(subscribe(client, [this.topics.course]))
      if (client !== this.client || this.stopped) return
      this.courseSubscriptionError = undefined
      await this.publishCourseAcknowledgement()
    } catch (error) {
      // Retry optional sync without degrading or closing telemetry transport.
      if (client === this.client && !this.stopped) { this.courseSubscriptionError = `Course sync unavailable: ${sanitizeError(String(error))}`; this.options.onState('online', this.courseSubscriptionError) }
    } finally { this.optionalCoursePending = false }
  }

  async publishEvidence(event: object): Promise<boolean> {
    if (!this.client?.connected || this.stopped) return false
    await this.publish(this.client, this.topics.events, JSON.stringify({ v: 1, kind: 'race', deviceId: this.credentials.deviceId, ...event }), { qos: 1 })
    return true
  }

  async publishRacePlanSnapshot(snapshot: object): Promise<boolean> {
    if (!this.client?.connected || this.stopped) return false
    await this.publish(this.client, this.topics.events, JSON.stringify({ v: 1, deviceId: this.credentials.deviceId, ...snapshot }), { qos: 1 })
    return true
  }

  async publishRacePackAck(ack: RacePackAck): Promise<void> {
    if (!this.client?.connected || this.stopped) return
    await this.publish(this.client, this.topics.racePackAck, JSON.stringify(ack), { qos: 1, retain: true })
  }

  // Best-effort bounded final retained status before local-only shutdown.
  // Transmission is blocked immediately (no subsequent sends) and no retry is
  // attempted; a failure or timeout cannot prevent the fail-closed shutdown.
  async publishFinalLocalOnlyStatus(timeoutMs = 1500): Promise<void> {
    const client = this.client
    this.stopped = true
    if (!client?.connected) return
    const payload = JSON.stringify({ v: 1, state: 'local_only', at: this.now(), uploadMode: 'local_only', calculationAuthority: 'onboard' })
    await Promise.race([
      publish(client, this.topics.status, payload, { qos: 1, retain: true }).catch(() => undefined),
      new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.() })
    ])
  }

  private async publishRacePackAcknowledgement(): Promise<void> {
    if (this.racePackSubscriptionError) return
    try {
      const ack = this.options.getRacePackAck?.()
      if (ack && this.client?.connected && !this.stopped) {
        await this.publish(this.client, this.topics.racePackAck, JSON.stringify(ack), { qos: 1, retain: true })
      }
    } catch { /* re-advertising the ACK is best effort */ }
  }

  updateProfile(profile: TelemetryProfile): void { this.profile = profile }

  updateStatus(metrics: PluginStatusMetrics): void {
    this.statusMetrics = metrics
    if (this.client?.connected) {
      void this.publish(this.client, this.topics.status, JSON.stringify(statusPayload(metrics.connectionState, this.effectiveStatusMetrics())), { qos: 1, retain: true })
        .catch((error) => this.transportFailure(error))
    }
  }

  transportMetrics(): Pick<PluginStatusMetrics, 'networkMode' | 'modeReason' | 'lastAcknowledgedAt' | 'acknowledgementLatencyMs' | 'reconnectCount' | 'publishedBytes' | 'courseSyncError' | 'racePackError'> {
    const health = this.monitor.current()
    return { courseSyncError: this.courseSubscriptionError, racePackError: this.racePackSubscriptionError, networkMode: health.mode, modeReason: health.reason, lastAcknowledgedAt: this.lastAcknowledgedAt,
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
    client.on('connect', () => void this.onConnect(client).catch((error) => { if (client === this.client && !this.stopped) { this.transportFailure(error); client.end(true) } }))
    client.on('message', (topic, payload) => { if (client === this.client && !this.stopped) void this.onMessage(topic, payload).catch((error) => { if (client === this.client && !this.stopped) this.transportFailure(error) }) })
    client.on('error', (error) => {
      if (client !== this.client || this.stopped) return
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
    this.supportsTripPolicy = false
    this.inFlight.forEach(batch => { batch.retry = true; batch.retryAfter = undefined; batch.timeoutMs = undefined })
    const stats = await this.outbox.stats()
    this.backlogMessageCount = stats.messageCount
    this.inFlight = this.inFlight.filter(batch => batch.through > stats.acknowledgedSequence)
    this.nextPublishAfter = Math.max(stats.acknowledgedSequence, ...this.inFlight.map(batch => batch.through))
    if (client !== this.client || this.stopped) return
    await subscribe(client, [this.topics.ack, this.topics.profile])
    if (client !== this.client || this.stopped) return
    // Course synchronisation is optional: neither its subscription nor native
    // provider inspection may hold the durable telemetry pump hostage.
    this.courseSubscriptionError = undefined
    this.optionalCourseAt = -Infinity
    // Race Pack downlink is likewise optional; a broker role that predates the
    // race-pack topics must not stop telemetry from draining. It is subscribed
    // without blocking the acknowledged-telemetry drain.
    this.racePackSubscriptionError = undefined
    void subscribe(client, [this.topics.racePackManifest, `${this.topics.racePackChunkPrefix}+`]).catch((error) => {
      if (client === this.client && !this.stopped) this.racePackSubscriptionError = `Race pack sync unavailable: ${sanitizeError(error instanceof Error ? error.message : String(error))}`
    })
    this.monitor.connected()
    this.syncMode()
    this.backlogTokenAt = this.now()
    this.backlogTokens = this.profile.transport.normalBacklogBytesPerSecond
    await this.publish(client, this.topics.status, JSON.stringify(statusPayload('online', this.effectiveStatusMetrics())), { qos: 1, retain: true })
    this.statePublishPending = this.current !== undefined
    await this.drainCurrentState()
    if (client !== this.client || this.stopped) return
    void this.syncOptionalCourse()
    void this.publishRacePackAcknowledgement()
    this.options.onState('online', this.courseSubscriptionError ?? this.racePackSubscriptionError)
    if (this.pumpTimer) clearInterval(this.pumpTimer)
    this.pumpTimer = setInterval(() => void this.pump(), 1000)
    void this.pump()
  }

  private async drainCurrentState(): Promise<void> {
    const client = this.client
    if (!client || this.statePublishInFlight === client) return
    this.statePublishInFlight = client
    try {
      while (client === this.client && this.statePublishPending && this.current && this.client?.connected && !this.stopped) {
        this.statePublishPending = false
        await this.publish(this.client, this.topics.state, JSON.stringify(this.current), { qos: 1, retain: true })
      }
    } finally { if (this.statePublishInFlight === client) this.statePublishInFlight = undefined }
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
    if (!client?.connected || this.stopped || this.pumpRunning === client || (this.inFlight.length >= 4 && !this.inFlight.some(batch => batch.retry))) return
    this.pumpRunning = client
    try {
      const stageStartedAt = this.now()
      const retry = this.inFlight.find(batch => batch.retry)
      const health = this.monitor.current()
      const byteRate = health.mode === 'CONSTRAINED' ? this.profile.transport.constrainedBacklogBytesPerSecond : this.profile.transport.normalBacklogBytesPerSecond
      const budget = this.refillBacklogBudget(byteRate)
      if (budget < 512) return
      let samples = await this.outbox.pendingAfter(retry ? retry.retryAfter ?? retry.first - 1 : this.nextPublishAfter, Math.min(60, this.profile.transport.batchSize), Math.min(budget, this.profile.transport.maxPayloadBytes - 1024))
      if (retry) samples = samples.filter(sample => sample.sequence <= retry.through)
      if (client !== this.client || this.stopped || !samples.length) return
      const stats = await this.outbox.stats()
      this.backlogMessageCount = stats.messageCount
      if (this.options.uploadDisposition) {
        const disposition = this.options.uploadDisposition(samples[0]!)
        if (disposition === 'wait') return
        if (disposition === 'skip') {
          // Older clouds do not understand exclusions. Keep the durable queue
          // intact and wait for a capability ACK; never label idle data lost.
          if (!this.supportsTripPolicy || this.inFlight.some(batch => batch !== retry)) return
          const skipped: TelemetrySample[] = []
          for (const sample of samples) {
            if (this.options.uploadDisposition(sample) !== 'skip') break
            if (skipped.length && sample.sequence !== skipped.at(-1)!.sequence + 1) break
            skipped.push(sample)
          }
          const through = skipped.at(-1)!.sequence
          if (client !== this.client || this.stopped) return
          if (retry) { retry.lastSentAt = this.now(); retry.retryAfter = through; retry.retry = through < retry.through }
          else this.inFlight.push({ first: skipped[0]!.sequence, through, sentAt: stageStartedAt, lastSentAt: this.now() })
          this.nextPublishAfter = Math.max(this.nextPublishAfter, through)
          await this.publish(client, this.topics.telemetry, JSON.stringify({ v: 1, deviceId: this.credentials.deviceId,
            nonTripFrom: skipped[0]!.sequence, nonTripThrough: through,
            ...(stats.droppedThrough > stats.acknowledgedSequence ? { droppedThrough: stats.droppedThrough } : {}), samples: [] }), { qos: 1 })
          return
        }
        const eligible: TelemetrySample[] = []
        for (const sample of samples) { if (!this.canUpload(sample)) break; eligible.push(sample) }
        samples = eligible
        // Qualification can become durable while the sampler is still
        // committing its newest frame. Publish the latest eligible state before
        // releasing departure history, without waiting for another sensor poll.
        if (!this.current) {
          const latest = await this.outbox.latest()
          if (latest && this.canUpload(latest)) { this.current = latest; this.statePublishPending = true }
        }
        await this.drainCurrentState()
      }
      const batch: TelemetryBatch = { v: 1, deviceId: this.credentials.deviceId,
        droppedThrough: stats.droppedThrough > stats.acknowledgedSequence ? stats.droppedThrough : undefined, samples }
      const payload = JSON.stringify(batch)
      if (Buffer.byteLength(payload) > this.profile.transport.maxPayloadBytes) throw new Error('Telemetry batch exceeds payload limit')
      for (const sample of samples) if (sample.evidence) {
        await this.publish(client, this.topics.events, JSON.stringify({ v: 1, deviceId: sample.deviceId, sequence: sample.sequence, ...sample.evidence }), { qos: 1 })
      }
      if (client !== this.client || this.stopped) return
      const through = samples.at(-1)!.sequence
      // Install the flight before MQTT publication: a cloud ACK may arrive
      // before the broker callback. Retried ranges retain their original age.
      const flight: InFlightBatch = { first: samples[0]!.sequence, through,
        sentAt: retry?.sentAt ?? stageStartedAt, lastSentAt: this.now(), selectionMs: this.now() - stageStartedAt, publishStartedAt: this.now() }
      if (retry) {
        retry.lastSentAt = flight.lastSentAt
        retry.retryAfter = through
        retry.retry = through < retry.through
      } else this.inFlight.push(flight)
      this.backlogTokens -= Buffer.byteLength(payload)
      this.nextPublishAfter = Math.max(this.nextPublishAfter, through)
      await this.publish(client, this.topics.telemetry, payload, { qos: 1 })
      if (client === this.client && !this.stopped) (retry ?? flight).brokerAt ??= this.now()
    } catch (error) { if (client === this.client && !this.stopped) this.transportFailure(error) }
    finally { if (this.pumpRunning === client) this.pumpRunning = undefined }
  }

  private async onMessage(topic: string, payload: Buffer): Promise<void> {
    if (topic === this.topics.ack) await this.handleAcknowledgement(payload)
    else if (topic === this.topics.profile) await this.handleProfile(payload)
    else if (topic === this.topics.course && this.options.onCourse) {
      try {
        await this.options.onCourse(payload)
        await this.publishCourseAcknowledgement()
      } catch { /* optional course failures never constrain telemetry */ }
    } else if (topic === this.topics.racePackManifest && this.options.onRacePackManifest) {
      const ack = await this.options.onRacePackManifest(payload)
      if (ack) await this.publishRacePackAck(ack)
    } else if (this.options.onRacePackChunk && topic.startsWith(this.topics.racePackChunkPrefix)) {
      const suffix = topic.slice(this.topics.racePackChunkPrefix.length)
      const topicIndex = /^\d+$/.test(suffix) ? Number(suffix) : Number.NaN
      const ack = await this.options.onRacePackChunk(payload, topicIndex)
      if (ack) await this.publishRacePackAck(ack)
    }
  }

  private acknowledgementOperation: Promise<void> = Promise.resolve()
  private handleAcknowledgement(payload: Buffer): Promise<void> {
    const receiptAt = this.now()
    const operation = this.acknowledgementOperation.then(() => this.commitAcknowledgement(payload, receiptAt))
    this.acknowledgementOperation = operation.catch(() => undefined)
    return operation
  }
  private async commitAcknowledgement(payload: Buffer, receiptAt: number): Promise<void> {
    if (payload.length > 4096) return
    try {
      const ack = JSON.parse(payload.toString('utf8')) as ApplicationAck
      if (ack.v !== 1 || ack.deviceId !== this.credentials.deviceId || !Number.isSafeInteger(ack.ackSequence)) return
      const before = await this.outbox.stats()
      if (ack.ackSequence < 0 || ack.ackSequence > before.currentSequence) return
      const acknowledgedBatch = this.inFlight.find((batch) => ack.ackSequence >= batch.first)
      this.supportsTripPolicy = ack.capabilities?.includes('confirmed-trip-upload-v1') === true
      const excludedCount = Number.isSafeInteger(ack.excludedSampleCount) && ack.excludedSampleCount! >= 0 ? ack.excludedSampleCount : undefined
      const persistenceAt = this.now()
      if (excludedCount === undefined) await this.outbox.acknowledge(ack.ackSequence)
      else await this.outbox.acknowledge(ack.ackSequence, excludedCount)
      const committed = await this.outbox.stats()
      if (committed.acknowledgedSequence > before.acknowledgedSequence && acknowledgedBatch) {
        this.acknowledgementLatencyMs = this.now() - acknowledgedBatch.sentAt
        this.uploadTiming = { selectionMs: acknowledgedBatch.selectionMs ?? 0,
          brokerMs: acknowledgedBatch.brokerAt === undefined ? null : acknowledgedBatch.brokerAt - (acknowledgedBatch.publishStartedAt ?? acknowledgedBatch.lastSentAt),
          receiptMs: Math.max(0, receiptAt - acknowledgedBatch.sentAt), persistenceMs: this.now() - persistenceAt,
          durableMs: this.acknowledgementLatencyMs }
        this.monitor.acknowledgement(this.acknowledgementLatencyMs)
      }
      if (Array.isArray(ack.recordingAcks) && ack.recordingAcks.length <= 25) {
        await this.options.onRecordingAcks?.(ack.recordingAcks.filter((entry) => entry && typeof entry.id === 'string' && Number.isSafeInteger(entry.lastSequence) && ['complete', 'cancelled', 'interrupted'].includes(entry.state)))
      }
      if (Array.isArray(ack.recordingStatuses) && ack.recordingStatuses.length <= 25) {
        const statuses = ack.recordingStatuses.filter((entry) => entry && typeof entry.id === 'string'
          && Number.isSafeInteger(entry.lastSequence) && entry.lastSequence > 0
          && ['uploading', 'waiting_for_history', 'processing', 'incomplete', 'error', 'interrupted', 'cancelled', 'not_a_trip', 'ready'].includes(entry.state)
          && (entry.environmentPending === undefined || typeof entry.environmentPending === 'boolean')
          && (entry.voyageId === null || (Number.isSafeInteger(entry.voyageId) && entry.voyageId > 0))
          && [entry.expectedSamples, entry.receivedSamples, entry.missingSamples, entry.rejectedSamples].every((count) => Number.isSafeInteger(count) && count >= 0)
          && entry.receivedSamples <= entry.expectedSamples && entry.missingSamples === Math.max(0, entry.expectedSamples - entry.receivedSamples - entry.rejectedSamples) && entry.rejectedSamples <= entry.expectedSamples
          && (entry.state !== 'ready' || (entry.voyageId !== null && entry.expectedSamples > 0 && entry.receivedSamples === entry.expectedSamples && entry.missingSamples === 0 && entry.rejectedSamples === 0)))
        if (statuses.length) await this.options.onRecordingStatuses?.(statuses)
      }
      if (Array.isArray(ack.racePlanSnapshotAcks) && ack.racePlanSnapshotAcks.length <= 25) {
        const ids = ack.racePlanSnapshotAcks.filter((entry) => entry && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 200).map((entry) => entry.id)
        if (ids.length) await this.options.onRacePlanSnapshotAcks?.(ids)
      }
      this.backlogMessageCount = committed.messageCount
      this.lastAcknowledgedAt = this.now()
      this.inFlight = this.inFlight.filter((batch) => batch.through > committed.acknowledgedSequence)
      this.syncMode()
      this.options.debug?.(`Application acknowledged telemetry through sequence ${ack.ackSequence}`)
      void this.pump()
    } catch {
      this.monitor.failure('invalid_acknowledgement'); this.syncMode()
      this.options.onState('degraded', 'Invalid application acknowledgement')
    }
  }

  private profileOperation: Promise<void> = Promise.resolve()

  private async handleProfile(payload: Buffer): Promise<void> {
    const operation = this.profileOperation.then(() => this.applyManagedProfile(payload))
    this.profileOperation = operation.then(() => undefined, () => undefined)
    const acknowledgement = await operation
    if (this.client?.connected) await this.publish(this.client, this.topics.profileAck, JSON.stringify(acknowledgement), { qos: 1, retain: true })
  }

  private async applyManagedProfile(payload: Buffer): Promise<ProfileAcknowledgement> {
    let acknowledgement: ProfileAcknowledgement
    try {
      if (payload.length > 16_384) throw new Error('profile_too_large')
      const profile = parseTelemetryProfile(JSON.parse(payload.toString('utf8')))
      if (!profile) throw new Error('profile_invalid')
      if (profile.profileId === this.profile.profileId && profile.revision < this.profile.revision) throw new Error('profile_revision_rollback')
      await this.options.onProfile?.(profile)
      this.profile = profile
      acknowledgement = { v: 1, profileId: profile.profileId, revision: profile.revision, status: 'applied', at: this.now() }
    } catch (error) {
      const candidate = safeProfileIdentity(payload)
      acknowledgement = { v: 1, profileId: candidate.profileId, revision: candidate.revision, status: 'rejected', at: this.now(), errorCode: sanitizeProfileError(error) }
    }
    return acknowledgement
  }

  private async checkAcknowledgementTimeout(): Promise<void> {
    const expired = this.inFlight.filter(batch => !batch.retry && this.now() - batch.lastSentAt >= (batch.timeoutMs ?? 30_000))
    if (!expired.length) return
    this.monitor.failure('acknowledgement_timeout')
    this.syncMode()
    for (const batch of expired) {
      batch.retry = true
      batch.retryAfter = undefined
      batch.timeoutMs = Math.min(120_000, (batch.timeoutMs ?? 30_000) * 2)
    }
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
    if (this.stopped) return
    this.monitor.failure('publish_failure')
    this.syncMode()
    this.options.onState('degraded', sanitizeError(error instanceof Error ? error.message : String(error)))
  }

  private async publish(client: MqttClient, topic: string, payload: string, options: { qos: 1; retain?: boolean }): Promise<void> {
    if (this.stopped || client !== this.client || !client.connected) return
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
    historicalUpload: metrics.historicalUpload, courseSyncError: metrics.courseSyncError, racePackError: metrics.racePackError,
    uploadMode: metrics.uploadMode, recordings: metrics.recordings,
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
  return mqttOperation(client, done => { client.publish(topic, payload, options, done) })
}
function subscribe(client: MqttClient, topics: string[]): Promise<void> {
  const subscriptions = Object.fromEntries(topics.map((topic) => [topic, { qos: 1 as const }]))
  return mqttOperation(client, done => { client.subscribe(subscriptions, done) })
}

// MQTT.js can abandon QoS callbacks when a connection is force-closed. Release
// every awaiting drain before reconnecting, otherwise pumpRunning/statePublish-
// InFlight can stay set forever even though the replacement client is online.
function mqttOperation(client: MqttClient, send: (done: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (error?: Error | null): void => {
      if (settled) return
      settled = true
      client.removeListener('close', closed)
      if (error) reject(error)
      else resolve()
    }
    const closed = (): void => done(new Error('MQTT connection closed before acknowledgement'))
    client.once('close', closed)
    try { send(done) } catch (error) { done(error instanceof Error ? error : new Error(String(error))) }
  })
}

function bounded<T>(operation: Promise<T>, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Optional course operation timed out')), timeoutMs)
    operation.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
