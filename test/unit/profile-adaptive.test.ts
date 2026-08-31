import { describe, expect, it } from 'vitest'
import { DEFAULT_TELEMETRY_PROFILE, parseTelemetryProfile } from '../../src/telemetry/profile'
import { PathSampler } from '../../src/telemetry/sampler'
import { AdaptiveModeMonitor } from '../../src/transport/adaptive-mode'

describe('telemetry profiles and adaptive transport', () => {
  it('rejects unknown telemetry fields and keeps navigation frequent when constrained', () => {
    expect(parseTelemetryProfile({ ...structuredClone(DEFAULT_TELEMETRY_PROFILE), paths: { ...DEFAULT_TELEMETRY_PROFILE.paths, fuel: { enabled: true, normalMs: 1000, constrainedMs: 1000, offlineMs: 1000 } } })).toBeUndefined()
    const sampler = new PathSampler(DEFAULT_TELEMETRY_PROFILE, 'CONSTRAINED')
    expect([...sampler.dueFields(1_000)]).toEqual(['position', 'sog', 'cog', 'heading', 'depth', 'apparentWind'])
    expect([...sampler.dueFields(2_000)]).toEqual(['position', 'sog', 'cog', 'heading'])
    expect([...sampler.dueFields(6_000)]).toContain('depth')
  })

  it('moves between offline, normal and constrained based on transport evidence', () => {
    let now = 0
    const monitor = new AdaptiveModeMonitor(() => now)
    expect(monitor.current().mode).toBe('OFFLINE')
    monitor.connected()
    expect(monitor.current().mode).toBe('NORMAL')
    monitor.reconnect(); monitor.reconnect()
    expect(monitor.current()).toMatchObject({ mode: 'CONSTRAINED', reason: 'frequent_reconnects' })
    monitor.acknowledgement(100)
    now = 120_001
    monitor.tick()
    expect(monitor.current()).toMatchObject({ mode: 'NORMAL', reason: 'healthy_transport' })
    monitor.disconnected()
    expect(monitor.current().mode).toBe('OFFLINE')
  })

  it('applies mode-specific sampling deterministically over an accelerated three-day voyage', () => {
    const sampler = new PathSampler(DEFAULT_TELEMETRY_PROFILE, 'NORMAL')
    const counts = new Map<string, number>()
    const hour = 3_600_000
    const duration = 72 * hour
    for (let now = 0; now < duration; now += 1000) {
      if (now === 24 * hour) sampler.updateMode('OFFLINE')
      if (now === 48 * hour) sampler.updateMode('CONSTRAINED')
      if (now === 60 * hour) sampler.updateMode('NORMAL')
      for (const field of sampler.dueFields(now)) counts.set(field, (counts.get(field) ?? 0) + 1)
    }
    expect(counts.get('position')).toBe(259_200)
    expect(counts.get('sog')).toBe(259_200)
    expect(counts.get('cog')).toBe(259_200)
    expect(counts.get('heading')).toBe(259_200)
    expect(counts.get('depth')).toBe(146_880)
    expect(counts.get('apparentWind')).toBe(146_880)
  })
})
