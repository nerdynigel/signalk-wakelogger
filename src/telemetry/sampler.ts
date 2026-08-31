import { periodFor, type TelemetryProfile } from './profile'
import type { NetworkMode, TelemetryField } from './types'

export class PathSampler {
  private lastIncluded = new Map<TelemetryField, number>()

  constructor(private profile: TelemetryProfile, private mode: NetworkMode = 'OFFLINE') {}

  updateProfile(profile: TelemetryProfile): void {
    this.profile = profile
    this.lastIncluded.clear()
  }

  updateMode(mode: NetworkMode): void {
    if (this.mode !== mode) this.lastIncluded.clear()
    this.mode = mode
  }

  currentMode(): NetworkMode { return this.mode }
  currentProfile(): TelemetryProfile { return this.profile }

  samplePeriodMs(): number {
    return periodFor(this.profile, 'position', this.mode)
  }

  dueFields(now: number): Set<TelemetryField> {
    const due = new Set<TelemetryField>(['position'])
    this.lastIncluded.set('position', now)
    for (const field of ['sog', 'cog', 'heading', 'depth', 'apparentWind'] as const) {
      const config = this.profile.paths[field]
      if (!config.enabled) continue
      const last = this.lastIncluded.get(field) ?? Number.NEGATIVE_INFINITY
      if (now - last >= periodFor(this.profile, field, this.mode)) {
        due.add(field)
        this.lastIncluded.set(field, now)
      }
    }
    return due
  }
}
