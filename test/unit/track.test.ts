import { describe, expect, it } from 'vitest'
import { buildTrackResult, selectTrackIndexes } from '../../src/tracking/track'
import type { TelemetrySample } from '../../src/telemetry/types'

function sample(sequence: number, latitude = -27 + sequence / 1000, longitude = 153): TelemetrySample {
  return {
    v: 1, deviceId: 'dev', sequence, capturedAt: 1_000_000 + sequence * 1000, receivedAt: 1_000_000 + sequence * 1000,
    values: { lat: latitude, lon: longitude }, quality: { timestamp: 'source' }
  }
}

describe('track decimation selection', () => {
  it('keeps every point when under the display bound', () => {
    expect(selectTrackIndexes(3, 10)).toEqual([0, 1, 2])
    expect(selectTrackIndexes(0, 10)).toEqual([])
  })

  it('always preserves the first and last captured point', () => {
    const indexes = selectTrackIndexes(1000, 10)
    expect(indexes[0]).toBe(0)
    expect(indexes[indexes.length - 1]).toBe(999)
    expect(indexes).toHaveLength(10)
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)
  })
})

describe('durable track reconstruction', () => {
  it('returns captured-time/sequence-ordered points from a bounded query', () => {
    const result = buildTrackResult([sample(3), sample(1), sample(2)], { storageBackend: 'file', maxPoints: 100 })
    expect(result.points.map((point) => point.sequence)).toEqual([1, 2, 3])
    expect(result.summary).toEqual({ fromSequence: 1, throughSequence: 3, totalSamples: 3, decimated: false })
    expect(result.storageBackend).toBe('file')
  })

  it('searches only from the current recording start and decimates for display', () => {
    const samples = Array.from({ length: 100 }, (_, index) => sample(index + 1))
    const result = buildTrackResult(samples, { storageBackend: 'database', fromSequence: 51, maxPoints: 10 })
    expect(result.summary.fromSequence).toBe(51)
    expect(result.summary.throughSequence).toBe(100)
    expect(result.summary.totalSamples).toBe(50)
    expect(result.summary.decimated).toBe(true)
    expect(result.points).toHaveLength(10)
    expect(result.points[0]!.sequence).toBe(51)
    expect(result.points[result.points.length - 1]!.sequence).toBe(100)
  })

  it('skips records without a usable position', () => {
    const broken = sample(2)
    broken.values = { lat: Number.NaN, lon: 153 }
    const result = buildTrackResult([sample(1), broken, sample(3)], { storageBackend: 'file' })
    expect(result.points.map((point) => point.sequence)).toEqual([1, 3])
    expect(result.summary.totalSamples).toBe(2)
  })
})
