import type { GuidanceConfig, LeewayCalibration, PolarPoint } from '../guidance/core'
export const DEFAULTS = {
  pairingApiUrl: 'https://wakelogger.com/backend/v1/signalk/pair',
  samplePeriodMs: 1000,
  batchSize: 60,
  maxPayloadBytes: 64 * 1024,
  maxOutboxBytes: 250 * 1024 * 1024,
  maxOutboxAgeMs: 7 * 24 * 60 * 60 * 1000,
  segmentBytes: 4 * 1024 * 1024
} as const

export interface PluginConfig {
  guidance?: GuidanceConfig
  uploadMode: 'automatic' | 'local_only'
  pairingCode?: string
  pairingApiUrl: string
  samplePeriodMs: number
  maxOutboxMb: number
  maxOutboxDays: number
  debugTelemetry: boolean
  raceProgressionMode: 'auto' | 'suggest' | 'off'
}

export function parseConfig(value: object): PluginConfig {
  const input = value as Record<string, unknown>
  return {
    ...(input.guidance && typeof input.guidance === 'object' ? { guidance: parseGuidance(input.guidance as Record<string, unknown>) } : {}),
    uploadMode: input.uploadMode === 'local_only' ? 'local_only' : 'automatic',
    pairingCode: typeof input.pairingCode === 'string' && input.pairingCode.trim() ? input.pairingCode.trim() : undefined,
    pairingApiUrl:
      typeof input.pairingApiUrl === 'string' && /^https:\/\//.test(input.pairingApiUrl)
        ? input.pairingApiUrl
        : DEFAULTS.pairingApiUrl,
    samplePeriodMs: boundedNumber(input.samplePeriodMs, DEFAULTS.samplePeriodMs, 250, 60_000),
    maxOutboxMb: boundedNumber(input.maxOutboxMb, 250, 10, 4096),
    maxOutboxDays: boundedNumber(input.maxOutboxDays, 7, 1, 30),
    debugTelemetry: input.debugTelemetry === true,
    raceProgressionMode: input.raceProgressionMode === 'suggest' || input.raceProgressionMode === 'off' ? input.raceProgressionMode : 'auto'
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

function parseGuidance(input: Record<string, unknown>): GuidanceConfig {
  const config: GuidanceConfig = { enabled: input.enabled !== false }
  const c = input.calibration as Partial<LeewayCalibration> | null
  if (c?.validated === true && typeof c.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(c.id)
    && typeof c.heelCoefficient === 'number' && Number.isFinite(c.heelCoefficient) && Math.abs(c.heelCoefficient) <= 100) {
    const valid = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    config.calibration = { id: c.id, validated: true, heelCoefficient: c.heelCoefficient,
      ...(valid(c.portHeelCoefficient, -100, 100) ? { portHeelCoefficient: c.portHeelCoefficient } : {}),
      ...(valid(c.starboardHeelCoefficient, -100, 100) ? { starboardHeelCoefficient: c.starboardHeelCoefficient } : {}),
      ...(valid(c.rudderCoefficient, -2, 2) ? { rudderCoefficient: c.rudderCoefficient } : {}),
      ...(valid(c.minSpeedKn, 0.5, 10) ? { minSpeedKn: c.minSpeedKn } : {}),
      ...(valid(c.maxLeewayDeg, 1, 25) ? { maxLeewayDeg: c.maxLeewayDeg } : {}) }
  }
  const polar = input.polar as { id?: unknown; validated?: unknown; points?: unknown } | null
  if (polar?.validated === true && typeof polar.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(polar.id) && Array.isArray(polar.points) && polar.points.length >= 1 && polar.points.length <= 100) {
    const points = polar.points as PolarPoint[]
    if (points.every((p, i) => p && typeof p === 'object' && [p.twsKn, p.upwindTwaDeg, p.upwindSpeedKn, p.downwindTwaDeg, p.downwindSpeedKn].every(Number.isFinite)
      && p.twsKn >= 0 && p.twsKn <= 150 && (i === 0 || p.twsKn > points[i - 1]!.twsKn)
      && p.upwindTwaDeg >= 20 && p.upwindTwaDeg <= 75 && p.downwindTwaDeg >= 100 && p.downwindTwaDeg <= 175
      && p.upwindSpeedKn >= 0.5 && p.upwindSpeedKn <= 80 && p.downwindSpeedKn >= 0.5 && p.downwindSpeedKn <= 80))
      config.polar = { id: polar.id, validated: true, points: points.map(p => ({ twsKn: p.twsKn, upwindTwaDeg: p.upwindTwaDeg, upwindSpeedKn: p.upwindSpeedKn, downwindTwaDeg: p.downwindTwaDeg, downwindSpeedKn: p.downwindSpeedKn })) }
  }
  return config
}
