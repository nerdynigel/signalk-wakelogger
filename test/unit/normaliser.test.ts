import { describe, expect, it } from 'vitest'
import { TelemetryNormaliser } from '../../src/signalk/normaliser'

function delta(timestamp: string, values: Array<{ path: string; value: unknown }>): any {
  return { updates: [{ timestamp, values }] }
}

describe('TelemetryNormaliser', () => {
  it('normalises the supported Signal K fields and SI units', () => {
    const normaliser = new TelemetryNormaliser()
    const now = Date.parse('2026-08-31T01:02:04Z')
    normaliser.ingest(delta('2026-08-31T01:02:03Z', [
      { path: 'navigation.position', value: { latitude: -27.41238, longitude: 153.18291 } },
      { path: 'navigation.speedOverGround', value: 3.30377 },
      { path: 'navigation.courseOverGroundTrue', value: Math.PI },
      { path: 'navigation.headingTrue', value: -Math.PI / 2 },
      { path: 'environment.depth.belowTransducer', value: 12.4 },
      { path: 'environment.wind.speedApparent', value: 5.14444 },
      { path: 'environment.wind.angleApparent', value: -Math.PI / 4 }
    ]), now)

    expect(normaliser.takeSample(now)).toEqual({
      capturedAt: Date.parse('2026-08-31T01:02:03Z'), receivedAt: now,
      values: {
        lat: -27.41238, lon: 153.18291, sog_kn: 6.422015, cog_deg: 180,
        heading_deg: 270, heading_reference: 'true', depth_m: 12.4, aws_kn: 9.999991, awa_deg: 315
      },
      quality: { timestamp: 'source' }
    })
  })

  it('rejects NMEA sentinels and bad time anchors without losing valid position', () => {
    const normaliser = new TelemetryNormaliser()
    const now = Date.parse('2026-08-31T00:00:00Z')
    normaliser.ingest(delta('1980-01-06T02:16:05Z', [
      { path: 'navigation.position', value: { latitude: -27, longitude: 153 } },
      { path: 'environment.depth.belowTransducer', value: 42_949_672.92 },
      { path: 'navigation.headingMagnetic', value: Math.PI / 2 }
    ]), now)
    const sample = normaliser.takeSample(now)
    expect(sample?.capturedAt).toBe(now)
    expect(sample?.quality).toEqual({ timestamp: 'receipt' })
    expect(sample?.values.depth_m).toBeUndefined()
    expect(sample?.values.heading_deg).toBe(90)
    expect(sample?.values.heading_reference).toBe('magnetic')
  })

  it('does not emit without position or when nothing changed', () => {
    const normaliser = new TelemetryNormaliser()
    normaliser.ingest(delta('2026-08-31T00:00:00Z', [{ path: 'navigation.speedOverGround', value: 2 }]))
    expect(normaliser.takeSample()).toBeUndefined()
    normaliser.ingest(delta('2026-08-31T00:00:00Z', [{ path: 'navigation.position', value: { latitude: 0, longitude: 0 } }]))
    expect(normaliser.takeSample()).toBeDefined()
    expect(normaliser.takeSample()).toBeUndefined()
  })
})
