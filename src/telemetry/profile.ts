import type { NetworkMode, TelemetryField } from './types'

export interface PathRateProfile {
  enabled: boolean
  normalMs: number
  constrainedMs: number
  offlineMs: number
}

export interface TelemetryProfile {
  v: 1
  profileId: string
  revision: number
  issuedAt: number
  paths: Record<TelemetryField, PathRateProfile>
  transport: {
    batchSize: number
    maxPayloadBytes: number
    normalBacklogBytesPerSecond: number
    constrainedBacklogBytesPerSecond: number
  }
}

export interface ProfileAcknowledgement {
  v: 1
  profileId: string
  revision: number
  status: 'applied' | 'rejected'
  at: number
  errorCode?: string
}

const navRate = { enabled: true, normalMs: 1000, constrainedMs: 1000, offlineMs: 1000 }
const secondaryRate = { enabled: true, normalMs: 1000, constrainedMs: 5000, offlineMs: 10_000 }

export const DEFAULT_TELEMETRY_PROFILE: TelemetryProfile = {
  v: 1,
  profileId: 'standard',
  revision: 1,
  issuedAt: 0,
  paths: {
    position: { ...navRate }, sog: { ...navRate }, cog: { ...navRate }, heading: { ...navRate },
    depth: { ...secondaryRate }, apparentWind: { ...secondaryRate }
  },
  transport: {
    batchSize: 60,
    maxPayloadBytes: 64 * 1024,
    normalBacklogBytesPerSecond: 64 * 1024,
    constrainedBacklogBytesPerSecond: 8 * 1024
  }
}

export function parseTelemetryProfile(value: unknown): TelemetryProfile | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (input.v !== 1 || !validId(input.profileId) || !positiveInteger(input.revision) || !nonNegativeNumber(input.issuedAt)) return undefined
  if (!input.paths || typeof input.paths !== 'object' || !input.transport || typeof input.transport !== 'object') return undefined
  const paths = input.paths as Record<string, unknown>
  const parsedPaths = {} as Record<TelemetryField, PathRateProfile>
  for (const field of fields()) {
    const parsed = parsePathRate(paths[field], field === 'position')
    if (!parsed) return undefined
    parsedPaths[field] = parsed
  }
  if (Object.keys(paths).some((key) => !fields().includes(key as TelemetryField))) return undefined
  const transport = input.transport as Record<string, unknown>
  if (!integerBetween(transport.batchSize, 1, 120) || !integerBetween(transport.maxPayloadBytes, 8192, 65_536) ||
      !integerBetween(transport.normalBacklogBytesPerSecond, 1024, 262_144) ||
      !integerBetween(transport.constrainedBacklogBytesPerSecond, 512, 65_536) ||
      transport.constrainedBacklogBytesPerSecond > transport.normalBacklogBytesPerSecond) return undefined
  return {
    v: 1, profileId: input.profileId, revision: input.revision, issuedAt: input.issuedAt,
    paths: parsedPaths,
    transport: {
      batchSize: transport.batchSize,
      maxPayloadBytes: transport.maxPayloadBytes,
      normalBacklogBytesPerSecond: transport.normalBacklogBytesPerSecond,
      constrainedBacklogBytesPerSecond: transport.constrainedBacklogBytesPerSecond
    }
  }
}

export function legacyProfile(samplePeriodMs?: number, batchSize?: number): TelemetryProfile {
  const period = integerBetween(samplePeriodMs, 250, 60_000) ? samplePeriodMs : 1000
  return {
    ...structuredClone(DEFAULT_TELEMETRY_PROFILE),
    paths: Object.fromEntries(fields().map((field) => [field, {
      ...DEFAULT_TELEMETRY_PROFILE.paths[field],
      normalMs: period,
      constrainedMs: field === 'depth' || field === 'apparentWind' ? Math.max(period, 5000) : period,
      offlineMs: field === 'depth' || field === 'apparentWind' ? Math.max(period, 10_000) : period
    }])) as Record<TelemetryField, PathRateProfile>,
    transport: { ...DEFAULT_TELEMETRY_PROFILE.transport, batchSize: integerBetween(batchSize, 1, 60) ? batchSize : 60 }
  }
}

export function periodFor(profile: TelemetryProfile, field: TelemetryField, mode: NetworkMode): number {
  const rate = profile.paths[field]
  return mode === 'NORMAL' ? rate.normalMs : mode === 'CONSTRAINED' ? rate.constrainedMs : rate.offlineMs
}

function parsePathRate(value: unknown, required: boolean): PathRateProfile | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (typeof input.enabled !== 'boolean' || (required && !input.enabled)) return undefined
  if (!integerBetween(input.normalMs, 250, 600_000) || !integerBetween(input.constrainedMs, 250, 600_000) || !integerBetween(input.offlineMs, 250, 600_000)) return undefined
  if (!(input.normalMs <= input.constrainedMs && input.constrainedMs <= input.offlineMs)) return undefined
  return { enabled: input.enabled, normalMs: input.normalMs, constrainedMs: input.constrainedMs, offlineMs: input.offlineMs }
}

function fields(): TelemetryField[] { return ['position', 'sog', 'cog', 'heading', 'depth', 'apparentWind'] }
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegativeNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function integerBetween(value: unknown, min: number, max: number): value is number { return Number.isInteger(value) && Number(value) >= min && Number(value) <= max }
