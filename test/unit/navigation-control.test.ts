import { describe, expect, it } from 'vitest'
import { NavigationControlLease } from '../../src/race/navigation-control'

describe('navigation control lease', () => {
  it('grants one controller and rejects another', () => {
    const lease = new NavigationControlLease(30_000, () => 1000)
    expect(lease.claim('a').ok).toBe(true)
    expect(lease.claim('a').ok).toBe(true) // renewal by the holder
    const other = lease.claim('b')
    expect(other.ok).toBe(false)
    expect(other.state).toMatchObject({ clientId: 'a', generation: 1, active: true })
  })

  it('increments the generation on handover so a stale command fails', () => {
    let now = 0
    const lease = new NavigationControlLease(30_000, () => now)
    const first = lease.claim('a').state
    lease.release('a')
    now += 1
    const second = lease.claim('b').state
    expect(second.generation).toBeGreaterThan(first.generation!)
    expect(lease.check('a', first.generation!)).toBe('not_held')
    expect(lease.check('b', second.generation!)).toBe('ok')
  })

  it('reports expiry and rejects commands after the lease elapses', () => {
    let now = 0
    const lease = new NavigationControlLease(30_000, () => now)
    const state = lease.claim('a').state
    now += 30_001
    expect(lease.check('a', state.generation!)).toBe('expired')
    expect(lease.status().active).toBe(false)
    // A new owner after expiry gets a fresh generation.
    expect(lease.claim('b').state.generation).toBeGreaterThan(state.generation!)
  })

  it('never treats a permit as applied (application is observed from native state)', () => {
    // The lease only authorises; it exposes no "applied" state that could be
    // mistaken for a completed native write.
    const lease = new NavigationControlLease(30_000, () => 0)
    lease.claim('a')
    expect('markApplied' in lease).toBe(false)
    expect('isApplied' in lease).toBe(false)
  })
})
