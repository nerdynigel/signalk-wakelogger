import { randomUUID } from 'node:crypto'
import type { TelemetryDraft, TripEvidence } from '../telemetry/types'

export type TripState = 'STOPPED' | 'START_CANDIDATE' | 'MOVING' | 'STOP_CANDIDATE'

export interface TripSnapshot {
  state: TripState
  candidateAt?: number
  candidatePosition?: { lat: number; lon: number }
  stationaryPosition?: { lat: number; lon: number }
  trackingSessionId?: string
}

export interface TripThresholds {
  startSogKn: number
  startDistanceM: number
  startDwellMs: number
  stopSogKn: number
  stopRadiusM: number
  stopDwellMs: number
}

const DEFAULT_THRESHOLDS: TripThresholds = {
  startSogKn: 1.5,
  startDistanceM: 200,
  startDwellMs: 2 * 60_000,
  stopSogKn: 0.5,
  stopRadiusM: 75,
  stopDwellMs: 15 * 60_000
}

export class TripStateMachine {
  private snapshot: TripSnapshot

  constructor(snapshot?: Partial<TripSnapshot>, private readonly thresholds = DEFAULT_THRESHOLDS) {
    this.snapshot = {
      state: validState(snapshot?.state) ? snapshot.state : 'STOPPED',
      candidateAt: finite(snapshot?.candidateAt) ? snapshot.candidateAt : undefined,
      candidatePosition: validPosition(snapshot?.candidatePosition) ? snapshot.candidatePosition : undefined,
      stationaryPosition: validPosition(snapshot?.stationaryPosition) ? snapshot.stationaryPosition : undefined,
      trackingSessionId: typeof snapshot?.trackingSessionId === 'string' ? snapshot.trackingSessionId : undefined
    }
  }

  process(sample: TelemetryDraft): TripEvidence | undefined {
    const position = { lat: sample.values.lat, lon: sample.values.lon }
    const sog = sample.values.sog_kn ?? 0
    const at = sample.capturedAt
    switch (this.snapshot.state) {
      case 'STOPPED': {
        const origin = this.snapshot.stationaryPosition ?? position
        this.snapshot.stationaryPosition = origin
        const distance = distanceMetres(origin, position)
        if (sog > this.thresholds.startSogKn || distance > this.thresholds.startDistanceM) {
          this.snapshot = { state: 'START_CANDIDATE', candidateAt: at, candidatePosition: origin }
          return evidence('trip_start_candidate', at, sog, distance, 0)
        }
        if (distance <= this.thresholds.stopRadiusM) {
          this.snapshot.stationaryPosition = {
            lat: origin.lat * 0.9 + position.lat * 0.1,
            lon: origin.lon * 0.9 + position.lon * 0.1
          }
        }
        return undefined
      }
      case 'START_CANDIDATE': {
        const origin = this.snapshot.candidatePosition ?? position
        const distance = distanceMetres(origin, position)
        const duration = at - (this.snapshot.candidateAt ?? at)
        if (sog <= this.thresholds.stopSogKn && distance < this.thresholds.stopRadiusM) {
          this.snapshot = { state: 'STOPPED', stationaryPosition: position }
          return undefined
        }
        if (duration >= this.thresholds.startDwellMs) {
          const trackingSessionId = randomUUID()
          const effectiveAt = this.snapshot.candidateAt ?? at
          this.snapshot = { state: 'MOVING', trackingSessionId }
          return { ...evidence('trip_started', effectiveAt, sog, distance, duration), trackingSessionId }
        }
        return undefined
      }
      case 'MOVING':
        if (sog < this.thresholds.stopSogKn) {
          this.snapshot = {
            state: 'STOP_CANDIDATE', candidateAt: at, candidatePosition: position,
            trackingSessionId: this.snapshot.trackingSessionId
          }
          return { ...evidence('trip_stop_candidate', at, sog, 0, 0), trackingSessionId: this.snapshot.trackingSessionId }
        }
        return undefined
      case 'STOP_CANDIDATE': {
        const origin = this.snapshot.candidatePosition ?? position
        const distance = distanceMetres(origin, position)
        const duration = at - (this.snapshot.candidateAt ?? at)
        if (sog >= this.thresholds.stopSogKn || distance > this.thresholds.stopRadiusM) {
          this.snapshot = { state: 'MOVING', trackingSessionId: this.snapshot.trackingSessionId }
          return undefined
        }
        if (duration >= this.thresholds.stopDwellMs) {
          const trackingSessionId = this.snapshot.trackingSessionId
          const effectiveAt = this.snapshot.candidateAt ?? at
          this.snapshot = { state: 'STOPPED', stationaryPosition: position }
          return { ...evidence('trip_stopped', effectiveAt, sog, distance, duration), trackingSessionId }
        }
        return undefined
      }
    }
  }

  currentState(): TripSnapshot { return structuredClone(this.snapshot) }
  trackingSessionId(): string | undefined { return this.snapshot.trackingSessionId }
}

function evidence(event: TripEvidence['event'], effectiveAt: number, sogKn: number, distance: number, durationMs: number): TripEvidence {
  return {
    event, effectiveAt,
    reason: { sogKn, distanceMovedMetres: Math.round(distance), movementDurationSeconds: Math.round(durationMs / 1000) }
  }
}
function validState(value: unknown): value is TripState {
  return value === 'STOPPED' || value === 'START_CANDIDATE' || value === 'MOVING' || value === 'STOP_CANDIDATE'
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function validPosition(value: unknown): value is { lat: number; lon: number } {
  const position = value as { lat?: unknown; lon?: unknown } | undefined
  return finite(position?.lat) && finite(position?.lon) && Math.abs(position.lat) <= 90 && Math.abs(position.lon) <= 180
}
export function distanceMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const radius = 6_371_000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLon = (b.lon - a.lon) * Math.PI / 180
  const lat1 = a.lat * Math.PI / 180
  const lat2 = b.lat * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}
