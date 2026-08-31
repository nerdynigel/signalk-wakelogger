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
  close(): Promise<void>
}
