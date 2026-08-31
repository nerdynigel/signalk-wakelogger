import type { NetworkMode } from '../telemetry/types'

export class AdaptiveModeMonitor {
  private mode: NetworkMode = 'OFFLINE'
  private reason = 'mqtt_disconnected'
  private reconnects: number[] = []
  private slowAcknowledgements = 0
  private healthySince?: number

  constructor(private readonly now: () => number = Date.now) {}

  connected(): void {
    this.healthySince = this.now()
    if (this.mode === 'OFFLINE') this.set('NORMAL', 'mqtt_connected')
  }

  disconnected(reason = 'mqtt_disconnected'): void {
    this.healthySince = undefined
    this.set('OFFLINE', reason)
  }

  reconnect(): void {
    const now = this.now()
    this.reconnects = this.reconnects.filter((at) => now - at <= 5 * 60_000)
    this.reconnects.push(now)
    if (this.reconnects.length >= 2) this.constrain('frequent_reconnects')
  }

  acknowledgement(latencyMs: number): void {
    if (latencyMs > 5000) this.slowAcknowledgements += 1
    else this.slowAcknowledgements = 0
    if (this.slowAcknowledgements >= 3) this.constrain('slow_acknowledgements')
    if (this.mode === 'CONSTRAINED' && latencyMs < 3000) {
      this.healthySince ??= this.now()
    } else if (latencyMs >= 3000) this.healthySince = undefined
  }

  failure(reason = 'publish_failure'): void { this.constrain(reason) }

  tick(): void {
    if (this.mode === 'CONSTRAINED' && this.healthySince !== undefined && this.now() - this.healthySince >= 120_000) {
      this.slowAcknowledgements = 0
      this.reconnects = []
      this.set('NORMAL', 'healthy_transport')
    }
  }

  current(): { mode: NetworkMode; reason: string; reconnectCount: number } {
    return { mode: this.mode, reason: this.reason, reconnectCount: this.reconnects.length }
  }

  private constrain(reason: string): void {
    if (this.mode === 'OFFLINE') return
    this.healthySince = undefined
    this.set('CONSTRAINED', reason)
  }

  private set(mode: NetworkMode, reason: string): void { this.mode = mode; this.reason = reason }
}
