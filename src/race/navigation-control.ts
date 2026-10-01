// Leased, generation-stamped navigation-control ownership.
//
// Only one onboard client may hold control at a time. A new owner increments the
// generation, so a delayed command from a previous owner (or a stale tab) is
// rejected even though it may still hold an old client identity.
//
// This lease authorises a command; it never records that navigation has been
// applied. Whether progress actually advanced is decided only from observed
// native Signal K state (see the confirm step), because issuing a permit does not
// mean the (client-performed) native write happened or succeeded.
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
    }
    this.holder = { clientId, generation: this.generation, expiresAt: this.now() + this.leaseMs }
    return { ok: true, state: this.status() }
  }

  release(clientId: string): NavigationControlState {
    if (this.holder?.clientId === clientId) this.holder = undefined
    return this.status()
  }

  check(clientId: string, generation: number): 'ok' | 'expired' | 'not_held' {
    this.expire()
    if (!this.holder) return this.expiredFrom?.clientId === clientId && this.expiredFrom.generation === generation ? 'expired' : 'not_held'
    if (this.holder.clientId !== clientId || this.holder.generation !== generation) return 'not_held'
    return 'ok'
  }

  private expire(): void {
    if (this.holder && this.holder.expiresAt <= this.now()) {
      this.expiredFrom = { clientId: this.holder.clientId, generation: this.holder.generation }
      this.holder = undefined
    }
  }
}
