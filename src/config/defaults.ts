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
  pairingCode?: string
  pairingApiUrl: string
  samplePeriodMs: number
  maxOutboxMb: number
  maxOutboxDays: number
  debugTelemetry: boolean
}

export function parseConfig(value: object): PluginConfig {
  const input = value as Record<string, unknown>
  return {
    pairingCode: typeof input.pairingCode === 'string' && input.pairingCode.trim() ? input.pairingCode.trim() : undefined,
    pairingApiUrl:
      typeof input.pairingApiUrl === 'string' && /^https:\/\//.test(input.pairingApiUrl)
        ? input.pairingApiUrl
        : DEFAULTS.pairingApiUrl,
    samplePeriodMs: boundedNumber(input.samplePeriodMs, DEFAULTS.samplePeriodMs, 250, 60_000),
    maxOutboxMb: boundedNumber(input.maxOutboxMb, 250, 10, 4096),
    maxOutboxDays: boundedNumber(input.maxOutboxDays, 7, 1, 30),
    debugTelemetry: input.debugTelemetry === true
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
}
