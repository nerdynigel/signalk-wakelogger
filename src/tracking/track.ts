// Shared track geometry for the onboard map. The durable archive (not the
// delivery outbox) is the source of truth, so track availability never depends
// on whether telemetry has already been uploaded and acknowledged.
export interface TrackPoint {
  sequence: number
  capturedAt: number
  latitude: number
  longitude: number
}

export interface TrackSummary {
  fromSequence: number | null
  throughSequence: number | null
  totalSamples: number
  decimated: boolean
}

export interface TrackResult {
  storageBackend: 'archive'
  points: TrackPoint[]
  summary: TrackSummary
}

export const DEFAULT_TRACK_POINTS = 2000
export const MAX_TRACK_POINTS = 5000

// Deterministic uniform decimation for display. Raw recording data is never
// modified: this only selects which record indexes to return. Both the first
// and last captured points are always retained so the displayed trip keeps its
// true departure and latest position.
export function selectTrackIndexes(total: number, maxPoints: number): number[] {
  if (!Number.isFinite(total) || total <= 0) return []
  const limit = Math.max(2, Math.min(MAX_TRACK_POINTS, Math.floor(maxPoints) || DEFAULT_TRACK_POINTS))
  if (total <= limit) return Array.from({ length: total }, (_, index) => index)
  const indexes: number[] = []
  for (let index = 0; index < limit; index += 1) {
    const selected = Math.round((index * (total - 1)) / (limit - 1))
    if (indexes[indexes.length - 1] !== selected) indexes.push(selected)
  }
  return indexes
}
