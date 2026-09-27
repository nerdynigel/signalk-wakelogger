import type { TelemetrySample } from '../telemetry/types'
import type { TrackPoint, TrackResult, TrackSummary } from '../outbox/interface'

export const DEFAULT_TRACK_POINTS = 2000
export const MAX_TRACK_POINTS = 5000

// Deterministic uniform decimation for display. The raw recording is never
// modified: this only selects which indexes to return. Both the first and last
// captured points are always retained so the displayed trip keeps its true
// departure and latest position.
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

export function toTrackPoint(sample: TelemetrySample): TrackPoint | null {
  const latitude = sample.values?.lat
  const longitude = sample.values?.lon
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { sequence: sample.sequence, capturedAt: sample.capturedAt, latitude, longitude }
}

export function buildTrackResult(
  samples: TelemetrySample[],
  options: { storageBackend: 'file' | 'database'; fromSequence?: number; maxPoints?: number }
): TrackResult {
  const fromSequence = Math.max(1, Math.floor(options.fromSequence ?? 1))
  const qualifying = samples
    .filter((sample) => Number.isSafeInteger(sample.sequence) && sample.sequence >= fromSequence)
    .map(toTrackPoint)
    .filter((point): point is TrackPoint => point !== null)
    .sort((a, b) => a.sequence - b.sequence)
  const indexes = new Set(selectTrackIndexes(qualifying.length, options.maxPoints ?? DEFAULT_TRACK_POINTS))
  const points = qualifying.filter((_, index) => indexes.has(index))
  const summary: TrackSummary = {
    fromSequence: qualifying[0]?.sequence ?? null,
    throughSequence: qualifying[qualifying.length - 1]?.sequence ?? null,
    totalSamples: qualifying.length,
    decimated: points.length < qualifying.length
  }
  return { storageBackend: options.storageBackend, points, summary }
}
