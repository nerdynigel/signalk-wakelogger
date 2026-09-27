import type { TelemetryDraft, TelemetrySample } from '../telemetry/types'

export interface OutboxStats {
  storageBackend: 'file' | 'database'
  messageCount: number
  diskBytes: number
  oldestCapturedAt?: number
  acknowledgedSequence: number
  currentSequence: number
  droppedCount: number
  droppedThrough: number
}

export interface OutboxSeed {
  currentSequence: number
  acknowledgedSequence: number
  droppedCount: number
  droppedThrough: number
}

export interface TrackPoint {
  sequence: number
  capturedAt: number
  latitude: number
  longitude: number
}

export interface TrackQuery {
  /** Inclusive lower sequence bound. Defaults to 1. */
  fromSequence?: number
  /** Display bound; the raw recording is never modified. Defaults to 2000. */
  maxPoints?: number
}

export interface TrackSummary {
  fromSequence: number | null
  throughSequence: number | null
  totalSamples: number
  decimated: boolean
}

export interface TrackResult {
  storageBackend: 'file' | 'database'
  points: TrackPoint[]
  summary: TrackSummary
}

export interface OutboxOptions {
  maxBytes: number
  maxAgeMs: number
  segmentBytes: number
  now?: () => number
}

export interface OutboxStore {
  open(): Promise<void>
  append(deviceId: string, draft: TelemetryDraft): Promise<TelemetrySample>
  pending(limit: number, maxBytes: number): Promise<TelemetrySample[]>
  pendingAfter(sequence: number, limit: number, maxBytes: number): Promise<TelemetrySample[]>
  latest(): Promise<TelemetrySample | undefined>
  acknowledge(sequence: number): Promise<void>
  stats(): Promise<OutboxStats>
  /** Reconstruct captured-time-ordered track points from durable local records. */
  track(query?: TrackQuery): Promise<TrackResult>
  close(): Promise<void>
}
