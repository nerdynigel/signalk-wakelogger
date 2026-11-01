import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RecordingAcknowledgement, RecordingManifest, TelemetryDraft, TelemetrySample, RecordingStatus } from '../telemetry/types'
import { TripStateMachine, distanceMetres, type TripSnapshot } from './state-machine'

interface RecordingSnapshot {
  version: 1
  uploadDecisions?: Record<string, 'confirmed' | 'cancelled'>
  idleRanges?: Array<{ first: number; last: number }>
  trip: TripSnapshot
  active?: RecordingManifest
  closed: RecordingManifest[]
  lastCapturedAt?: number
  lastSequence?: number
  committed?: { id: string; sequence: number; capturedAt: number; latitude: number; longitude: number }
  lastFinished?: RecordingManifest
  confirmations?: { manifest: RecordingManifest; status?: RecordingStatus }[]
  lastFinishedStatus?: RecordingStatus
  restartAfter?: number
}

// A gap this long cannot establish that the vessel remained on the same trip.
const INTERRUPTION_MS = 30 * 60_000

export class RecordingStore {
  private snapshot: RecordingSnapshot = { version: 1, trip: { state: 'STOPPED' }, closed: [] }
  private trip = new TripStateMachine()
  private manifestCursor = 0

  constructor(private readonly target: string) {}

  async open(legacy?: TripSnapshot): Promise<void> {
    try {
      const snapshot = JSON.parse(await fs.readFile(this.target, 'utf8')) as RecordingSnapshot
      if (snapshot.version !== 1 || !snapshot.trip || !['STOPPED', 'START_CANDIDATE', 'MOVING', 'STOP_CANDIDATE'].includes(snapshot.trip.state) || !Array.isArray(snapshot.closed) || (snapshot.active && (!validManifest(snapshot.active) || snapshot.active.state !== 'recording'))) throw new Error('Invalid recording checkpoint')
      // Older demo/rolled-back clocks could persist closed manifests whose end
      // precedes their start. The cloud can never acknowledge those, so drop
      // them instead of retrying them forever.
      const closed = snapshot.closed.filter(validManifest)
      this.snapshot = closed.length === snapshot.closed.length ? snapshot : { ...snapshot, closed }
      if (closed.length !== snapshot.closed.length) await this.persist(this.snapshot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (legacy) this.snapshot.trip = legacy
    }
    this.snapshot.uploadDecisions ??= {}
    if (this.snapshot.active && ['MOVING', 'STOP_CANDIDATE'].includes(this.snapshot.trip.state)) this.snapshot.uploadDecisions[this.snapshot.active.id] = 'confirmed'
    this.trip = new TripStateMachine(this.snapshot.trip)
  }

  isConfirmed(recordingId?: string | null): boolean { return !!recordingId && this.snapshot.uploadDecisions?.[recordingId] === 'confirmed' }

  uploadDisposition(sample: TelemetrySample): 'upload' | 'skip' | 'wait' {
    const id = sample.trackingSessionId ?? sample.recording?.id
    if (!id) return this.snapshot.idleRanges?.some(range => sample.sequence >= range.first && sample.sequence <= range.last) ? 'skip' : 'wait'
    const decision = this.snapshot.uploadDecisions?.[id]
    if (decision === 'confirmed') return 'upload'
    if (decision === 'cancelled' || sample.recording?.state === 'cancelled') return 'skip'
    return 'wait'
  }

  // Migration reads only. Do not assume that an unrecognised old recording is
  // idle: retain it unless durable start evidence or sustained displacement
  // establishes a trip. This runs once before opening the transport.
  async recoverUploadDecisions(outbox: import('../outbox/interface').OutboxStore): Promise<void> {
    const decisions = { ...this.snapshot.uploadDecisions }
    const idleRanges: Array<{ first: number; last: number }> = []
    let idle: { first: TelemetrySample; last: number; count: number; stationary: boolean; knownSlow: boolean } | undefined
    const flushIdle = () => {
      if (idle?.stationary && (idle.count > 1 || idle.knownSlow)) idleRanges.push({ first: idle.first.sequence, last: idle.last })
      idle = undefined
    }
    const origins = new Map<string, { first: TelemetrySample; lastAt: number }>()
    let cursor = 0
    while (true) {
      const samples = await outbox.pendingAfter(cursor, 250, 1024 * 1024)
      if (!samples.length) break
      for (const sample of samples) {
        const id = sample.trackingSessionId ?? sample.recording?.id
        if (!id && !sample.evidence) {
          const knownSlow = Number.isFinite(sample.values.sog_kn) && sample.values.sog_kn! >= 0 && sample.values.sog_kn! < 1.5
          const noSpeed = sample.values.sog_kn === undefined
          if (!idle) idle = { first: sample, last: sample.sequence, count: 0, stationary: true, knownSlow }
          idle.stationary &&= (knownSlow || noSpeed) && distanceMetres(
            { lat: idle.first.values.lat, lon: idle.first.values.lon }, { lat: sample.values.lat, lon: sample.values.lon }) < 75
          idle.last = sample.sequence; idle.count += 1
          continue
        }
        flushIdle()
        if (!id) continue
        if (sample.evidence?.event === 'trip_started') decisions[id] = 'confirmed'
        if (decisions[id] === 'confirmed') continue
        if (sample.recording?.state === 'cancelled') { decisions[id] = 'cancelled'; continue }
        const origin = origins.get(id)
        if (!origin || sample.capturedAt < origin.lastAt || sample.capturedAt - origin.lastAt > 5 * 60_000) origins.set(id, { first: sample, lastAt: sample.capturedAt })
        else {
          origin.lastAt = sample.capturedAt
          if (sample.capturedAt - origin.first.capturedAt >= 120_000 && distanceMetres(
            { lat: origin.first.values.lat, lon: origin.first.values.lon }, { lat: sample.values.lat, lon: sample.values.lon }) >= 200) decisions[id] = 'confirmed'
        }
      }
      const through = samples.at(-1)!.sequence
      if (through <= cursor) throw new Error('Unable to classify retained upload history')
      cursor = through
    }
    flushIdle()
    if (JSON.stringify(decisions) !== JSON.stringify(this.snapshot.uploadDecisions) || JSON.stringify(idleRanges) !== JSON.stringify(this.snapshot.idleRanges)) {
      const next = { ...this.snapshot, uploadDecisions: decisions, idleRanges }
      await this.persist(next); this.snapshot = next
    }
  }

  currentState(): TripSnapshot { return this.trip.currentState() }
  manifests(): RecordingManifest[] {
    return structuredClone([...this.snapshot.closed, ...(this.snapshot.active ? [this.snapshot.active] : [])])
  }

  statusManifests(): RecordingManifest[] {
    const closed = [...this.snapshot.closed, ...(this.snapshot.confirmations ?? []).map((entry) => entry.manifest).filter((manifest) => !this.snapshot.closed.some((entry) => entry.id === manifest.id))]
    const page: RecordingManifest[] = []
    for (let index = 0; index < Math.min(20, closed.length); index += 1) {
      const manifest = closed[(this.manifestCursor + index) % closed.length]
      if (manifest) page.push(manifest)
    }
    this.manifestCursor = closed.length ? (this.manifestCursor + page.length) % closed.length : 0
    const finished = this.snapshot.lastFinished
    if (finished && closed.some((entry) => entry.id === finished.id) && !page.some((entry) => entry.id === finished.id)) page.push(finished)
    const priority = (manifest: RecordingManifest): number => (this.snapshot.confirmations ?? []).some((entry) => entry.manifest.id === manifest.id) ? manifest.id === finished?.id ? 2 : 1 : 0
    page.sort((a, b) => priority(b) - priority(a))
    return structuredClone([...page, ...(this.snapshot.active ? [this.snapshot.active] : [])].filter(manifest => manifest.state !== 'recording' || this.snapshot.uploadDecisions?.[manifest.id] === 'confirmed'))
  }

  finishedStatus(): { manifest: RecordingManifest; uploadPending: boolean; confirmationPending: boolean; cloudStatus: RecordingStatus | null } | null {
    const manifest = this.snapshot.lastFinished
    return manifest ? { manifest: structuredClone(manifest), uploadPending: this.snapshot.closed.some((entry) => entry.id === manifest.id), confirmationPending: this.snapshot.lastFinishedStatus?.state !== 'ready', cloudStatus: this.snapshot.lastFinishedStatus ? structuredClone(this.snapshot.lastFinishedStatus) : null } : null
  }

  async confirm(statuses: RecordingStatus[]): Promise<void> {
    const next = structuredClone(this.snapshot)
    let changed = false
    for (const status of statuses) {
      const pending = next.confirmations?.find((entry) => entry.manifest.id === status.id && entry.manifest.lastSequence === status.lastSequence)
      if (!pending || status.expectedSamples !== status.lastSequence - pending.manifest.firstSequence + 1) continue
      if (status.state === 'ready' && (status.missingSamples !== 0 || status.rejectedSamples !== 0 || status.receivedSamples !== status.expectedSamples || !status.voyageId)) continue
      pending.status = structuredClone(status)
      if (next.lastFinished?.id === status.id) next.lastFinishedStatus = structuredClone(status)
      if (status.state === 'ready') next.confirmations = next.confirmations?.filter((entry) => entry !== pending)
      changed = true
    }
    if (!changed) return
    await this.persist(next)
    this.snapshot = next
  }

  // Only a successfully appended sample may establish explicit finish bounds.
  // This survives telemetry ACK/reclamation independently of the upload queue.
  async committed(sample: TelemetrySample): Promise<void> {
    if (!sample.trackingSessionId || sample.trackingSessionId !== this.snapshot.active?.id) return
    const previous = this.snapshot.committed
    if (previous?.id === sample.trackingSessionId && previous.sequence >= sample.sequence) return
    const next = structuredClone(this.snapshot)
    next.committed = { id: sample.trackingSessionId, sequence: sample.sequence,
      capturedAt: Math.max(sample.capturedAt, previous?.id === sample.trackingSessionId ? previous.capturedAt : sample.capturedAt),
      latitude: sample.values.lat, longitude: sample.values.lon }
    await this.persist(next)
    this.snapshot = next
  }

  async finish(expectedRecordingId: string, durableSequence?: number): Promise<RecordingManifest | null> {
    const active = this.snapshot.active
    if (active && active.id !== expectedRecordingId) throw new Error('recording_changed')
    if (!active) {
      if (this.snapshot.lastFinished?.id === expectedRecordingId) return structuredClone(this.snapshot.lastFinished)
      // The automatic stop may have won the serialized sampler/finish race.
      const completed = this.snapshot.closed.find((entry) => entry.id === expectedRecordingId && entry.state === 'complete')
      if (completed) {
        if (durableSequence !== undefined && (completed.lastSequence ?? Infinity) > durableSequence) throw new Error('recording_not_committed')
        const next = structuredClone(this.snapshot)
        next.lastFinished = structuredClone(completed)
        next.lastFinishedStatus = undefined
        next.confirmations = [...(next.confirmations ?? []), { manifest: structuredClone(completed) }]
        next.restartAfter = next.lastCapturedAt
        await this.persist(next)
        this.snapshot = next
        return structuredClone(completed)
      }
      return null
    }
    const committed = this.snapshot.committed
    if (!committed || committed.id !== active.id || committed.sequence < active.firstSequence || (durableSequence !== undefined && committed.sequence !== durableSequence) || (this.snapshot.lastSequence ?? 0) > committed.sequence) throw new Error('recording_not_committed')
    const closed: RecordingManifest = { ...active, state: 'complete', lastSequence: committed.sequence,
      endReason: 'explicit_finish',
      endedAt: Math.max(active.startedAt, committed.capturedAt) }
    const next = structuredClone(this.snapshot)
    next.closed.push(closed)
    next.active = undefined
    // Finish is the crew's explicit confirmation of this durable recording.
    next.uploadDecisions = { ...next.uploadDecisions, [closed.id]: 'confirmed' }
    next.lastFinished = closed
    next.lastFinishedStatus = undefined
    next.confirmations = [...(next.confirmations ?? []), { manifest: closed }]
    next.restartAfter = Math.max(closed.endedAt!, next.lastCapturedAt ?? closed.endedAt!)
    next.trip = { state: 'STOPPED', stationaryPosition: { lat: committed.latitude, lon: committed.longitude } }
    await this.persist(next)
    this.snapshot = next
    this.trip = new TripStateMachine(next.trip)
    return structuredClone(closed)
  }

  async acknowledge(acks: RecordingAcknowledgement[]): Promise<void> {
    const next = structuredClone(this.snapshot)
    next.closed = next.closed.filter((manifest) => !acks.some((ack) =>
      ack.id === manifest.id && ack.state === manifest.state && ack.lastSequence === manifest.lastSequence))
    if (next.closed.length === this.snapshot.closed.length) return
    await this.persist(next)
    this.snapshot = next
  }

  // Checkpoint BEFORE append: a power loss may leave a declared missing sample,
  // but can never make an incomplete recording look complete. Cloud receipt
  // counts must match both recording ID and sequence, never sequence alone.
  async prepare(draft: TelemetryDraft, sequence: number, movementSogKn = draft.values.sog_kn): Promise<void> {
    if (!this.snapshot.active && this.snapshot.restartAfter !== undefined && draft.capturedAt <= this.snapshot.restartAfter) return
    const next = structuredClone(this.snapshot)
    let trip = new TripStateMachine(next.trip)
    if (next.active) {
      next.lastCapturedAt = Math.max(next.active.startedAt, next.lastCapturedAt ?? next.active.startedAt)
      // Older checkpoints may contain a stop candidate from a clock rollback.
      // Discard that invalid evidence; require a fresh stationary dwell instead
      // of fabricating an end time or rejecting the remaining valid recording.
      if (next.trip.state === 'STOP_CANDIDATE' && (next.trip.candidateAt ?? Infinity) < next.active.startedAt) {
        trip = new TripStateMachine({ state: 'MOVING', trackingSessionId: next.active.id })
      }
    }
    if (next.active && next.lastCapturedAt !== undefined && draft.capturedAt - next.lastCapturedAt > INTERRUPTION_MS) {
      next.closed.push({ ...next.active, state: 'interrupted', endedAt: next.lastCapturedAt, lastSequence: next.lastSequence })
      next.active = undefined
      trip = new TripStateMachine()
    }
    // Retain raw out-of-order samples in the same durable sequence range, but
    // do not let an old source clock cancel a current trip or move its bounds
    // backwards. Receipt-time fallbacks and replayed instruments can interleave.
    const outOfOrder = next.lastCapturedAt !== undefined && draft.capturedAt < next.lastCapturedAt
    const evidence = outOfOrder ? undefined : trip.process({ ...draft, values: { ...draft.values, sog_kn: movementSogKn } })
    if (evidence) draft.evidence = evidence
    const state = trip.currentState()
    next.uploadDecisions ??= {}
    if (evidence?.event === 'trip_started' && evidence.trackingSessionId) next.uploadDecisions[evidence.trackingSessionId] = 'confirmed'
    if (!next.active && state.trackingSessionId) {
      next.active = { id: state.trackingSessionId, startedAt: evidence?.effectiveAt ?? draft.capturedAt, firstSequence: sequence, state: 'recording' }
    }
    if (next.active) {
      draft.trackingSessionId = next.active.id
      if (state.state === 'STOPPED') {
        const closed: RecordingManifest = {
          ...next.active, state: evidence?.event === 'trip_stopped' ? 'complete' : 'cancelled',
          endReason: evidence?.event === 'trip_stopped' ? 'stationary' : undefined,
          endedAt: Math.max(next.active.startedAt, evidence?.effectiveAt ?? draft.capturedAt), lastSequence: sequence
        }
        if (closed.state === 'cancelled' && next.uploadDecisions[next.active.id] !== 'confirmed') next.uploadDecisions[next.active.id] = 'cancelled'
        next.closed.push(closed)
        next.active = undefined
        draft.recording = closed
      } else draft.recording = structuredClone(next.active)
    }
    next.trip = state
    next.lastCapturedAt = Math.max(next.lastCapturedAt ?? draft.capturedAt, draft.capturedAt)
    next.lastSequence = sequence
    await this.persist(next)
    this.snapshot = next
    this.trip = trip
  }

  private async persist(next: RecordingSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 })
    const temporary = `${this.target}.tmp`
    const handle = await fs.open(temporary, 'w', 0o600)
    try { await handle.writeFile(`${JSON.stringify(next)}\n`); await handle.sync() }
    finally { await handle.close() }
    await fs.rename(temporary, this.target)
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(this.target), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }

  }
}

function validManifest(value: RecordingManifest): boolean {
  return !!value && typeof value.id === 'string' && /^[0-9a-f-]{36}$/i.test(value.id)
    && Number.isFinite(value.startedAt) && Number.isSafeInteger(value.firstSequence) && value.firstSequence > 0
    && ['recording', 'complete', 'cancelled', 'interrupted'].includes(value.state)
    && (value.state === 'recording' || (typeof value.endedAt === 'number' && Number.isFinite(value.endedAt) && value.endedAt >= value.startedAt && Number.isSafeInteger(value.lastSequence) && (value.lastSequence ?? 0) >= value.firstSequence))
}
