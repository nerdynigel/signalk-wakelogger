// Leased, generation-stamped navigation-control ownership.
//
// Only one onboard client may hold control at a time. A new owner increments the
// generation, so a delayed command from a previous owner (or a stale tab) is
// rejected even though it may still hold an old client identity. Applied
// applications are remembered per generation so a retry after a lost response is
// idempotent rather than a second advancement.
export const NAVIGATION_CONTROL_LEASE_MS = 30_000

export interface NavigationControlState {
  clientId: string | null
  generation: number | null
  active: boolean
  expiresAt: number | null
}

export class NavigationControlLease {
  private holder: { clientId: string; generation: number; expiresAt: number } | undefined
  private generation = 0
  private readonly applied = new Set<string>()
  private expiredFrom: { clientId: string; generation: number } | undefined

  constructor(private readonly leaseMs: number = NAVIGATION_CONTROL_LEASE_MS, private readonly now: () => number = Date.now) {}

  status(): NavigationControlState {
    this.expire()
    return this.holder
      ? { clientId: this.holder.clientId, generation: this.holder.generation, active: true, expiresAt: this.holder.expiresAt }
      : { clientId: null, generation: null, active: false, expiresAt: null }
  }

  claim(clientId: string): { ok: boolean; state: NavigationControlState } {
    this.expire()
    if (this.holder && this.holder.clientId !== clientId) return { ok: false, state: this.status() }
    if (!this.holder) {
      // Handover or first claim starts a new generation so stale commands fail.
      this.generation += 1
      this.applied.clear()
    }
    this.holder = { clientId, generation: this.generation, expiresAt: this.now() + this.leaseMs }
    return { ok: true, state: this.status() }
  }

  release(clientId: string): NavigationControlState {
    if (this.holder?.clientId === clientId) {
      this.holder = undefined
      this.applied.clear()
    }
    return this.status()
  }

  check(clientId: string, generation: number): 'ok' | 'expired' | 'not_held' {
    this.expire()
    if (!this.holder) return this.expiredFrom?.clientId === clientId && this.expiredFrom.generation === generation ? 'expired' : 'not_held'
    if (this.holder.clientId !== clientId || this.holder.generation !== generation) return 'not_held'
    return 'ok'
  }

  isApplied(key: string): boolean { return this.applied.has(key) }

  markApplied(key: string): void {
    if (this.applied.size > 512) this.applied.clear()
    this.applied.add(key)
  }

  private expire(): void {
    if (this.holder && this.holder.expiresAt <= this.now()) {
      this.expiredFrom = { clientId: this.holder.clientId, generation: this.holder.generation }
      this.holder = undefined
      this.applied.clear()
    }
  }
}
