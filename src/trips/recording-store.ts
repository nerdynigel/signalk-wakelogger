import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RecordingAcknowledgement, RecordingManifest, TelemetryDraft } from '../telemetry/types'
import { TripStateMachine, type TripSnapshot } from './state-machine'

interface RecordingSnapshot {
  version: 1
  trip: TripSnapshot
  active?: RecordingManifest
  closed: RecordingManifest[]
  lastCapturedAt?: number
  lastSequence?: number
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
      if (snapshot.version !== 1 || !snapshot.trip || !['STOPPED', 'START_CANDIDATE', 'MOVING', 'STOP_CANDIDATE'].includes(snapshot.trip.state) || !Array.isArray(snapshot.closed) || !snapshot.closed.every(validManifest) || (snapshot.active && (!validManifest(snapshot.active) || snapshot.active.state !== 'recording'))) throw new Error('Invalid recording checkpoint')
      this.snapshot = snapshot
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (legacy) this.snapshot.trip = legacy
    }
    this.trip = new TripStateMachine(this.snapshot.trip)
  }

  currentState(): TripSnapshot { return this.trip.currentState() }
  manifests(): RecordingManifest[] {
    return structuredClone([...this.snapshot.closed, ...(this.snapshot.active ? [this.snapshot.active] : [])])
  }

  statusManifests(): RecordingManifest[] {
    const closed = this.snapshot.closed
    const page: RecordingManifest[] = []
    for (let index = 0; index < Math.min(20, closed.length); index += 1) {
      const manifest = closed[(this.manifestCursor + index) % closed.length]
      if (manifest) page.push(manifest)
    }
    this.manifestCursor = closed.length ? (this.manifestCursor + page.length) % closed.length : 0
    return structuredClone([...page, ...(this.snapshot.active ? [this.snapshot.active] : [])])
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
  async prepare(draft: TelemetryDraft, sequence: number): Promise<void> {
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
    const evidence = outOfOrder ? undefined : trip.process(draft)
    if (evidence) draft.evidence = evidence
    const state = trip.currentState()
    if (!next.active && state.trackingSessionId) {
      next.active = { id: state.trackingSessionId, startedAt: evidence?.effectiveAt ?? draft.capturedAt, firstSequence: sequence, state: 'recording' }
    }
    if (next.active) {
      draft.trackingSessionId = next.active.id
      if (state.state === 'STOPPED') {
        const closed: RecordingManifest = {
          ...next.active, state: evidence?.event === 'trip_stopped' ? 'complete' : 'cancelled',
          endedAt: evidence?.effectiveAt ?? draft.capturedAt, lastSequence: sequence
        }
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
    && (value.state === 'recording' || (Number.isFinite(value.endedAt) && Number.isSafeInteger(value.lastSequence) && (value.lastSequence ?? 0) >= value.firstSequence))
}
