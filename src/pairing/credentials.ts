import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseTelemetryProfile, type TelemetryProfile } from '../telemetry/profile'

export interface LegacyTelemetryProfile { sample_period_ms?: number; batch_size?: number }
export interface OutboxBinding { version: 1; backend: 'file' | 'database'; initializedAt: number }

export interface DeviceCredentials {
  version: 1
  deviceId: string
  clientId: string
  username: string
  password: string
  mqttHost: string
  mqttPort: number
  tls: boolean
  pairedAt: number
  pairingCodeFingerprint?: string
  telemetryProfile?: TelemetryProfile | LegacyTelemetryProfile
  outboxBinding?: OutboxBinding
}

export class CredentialStore {
  private readonly credentialsFile: string
  private readonly identityFile: string

  constructor(private readonly directory: string) {
    this.credentialsFile = path.join(directory, 'credentials.json')
    this.identityFile = path.join(directory, 'installation-id')
  }

  async installationId(): Promise<string> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const value = (await fs.readFile(this.identityFile, 'utf8')).trim()
      if (/^[0-9a-f-]{36}$/i.test(value)) return value
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const value = randomUUID()
    await atomicWrite(this.identityFile, `${value}\n`)
    return value
  }

  async load(): Promise<DeviceCredentials | undefined> {
    try {
      const value = JSON.parse(await fs.readFile(this.credentialsFile, 'utf8')) as DeviceCredentials
      return validateCredentials(value) ? value : undefined
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  async save(credentials: DeviceCredentials): Promise<void> {
    if (!validateCredentials(credentials)) throw new Error('Pairing service returned invalid device credentials')
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    await atomicWrite(this.credentialsFile, `${JSON.stringify(credentials)}\n`)
  }
}

export function validateCredentials(value: DeviceCredentials): boolean {
  return value?.version === 1 && validId(value.deviceId) && validId(value.clientId) &&
    typeof value.username === 'string' && value.username.length > 0 && value.username.length <= 256 &&
    typeof value.password === 'string' && value.password.length >= 16 && value.password.length <= 4096 &&
    validHostname(value.mqttHost) && Number.isInteger(value.mqttPort) && value.mqttPort >= 1 && value.mqttPort <= 65535 &&
    typeof value.tls === 'boolean' &&
    Number.isFinite(value.pairedAt) &&
    (value.pairingCodeFingerprint === undefined || /^[0-9a-f]{64}$/.test(value.pairingCodeFingerprint)) &&
    validTelemetryProfile(value.telemetryProfile) && validOutboxBinding(value.outboxBinding)
}

export function fingerprintPairingCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

export function shouldExchangePairingCode(credentials: DeviceCredentials | undefined, code: string | undefined): code is string {
  return typeof code === 'string' && code.length > 0 && credentials?.pairingCodeFingerprint !== fingerprintPairingCode(code)
}

function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) }
function validHostname(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
}
function validTelemetryProfile(value: DeviceCredentials['telemetryProfile']): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null) return false
  if (parseTelemetryProfile(value)) return true
  const legacy = value as LegacyTelemetryProfile
  return (legacy.sample_period_ms === undefined || (Number.isInteger(legacy.sample_period_ms) && legacy.sample_period_ms >= 250 && legacy.sample_period_ms <= 60_000)) &&
    (legacy.batch_size === undefined || (Number.isInteger(legacy.batch_size) && legacy.batch_size >= 1 && legacy.batch_size <= 60))
}
function validOutboxBinding(value: DeviceCredentials['outboxBinding']): boolean {
  return value === undefined || (value.version === 1 && (value.backend === 'file' || value.backend === 'database') &&
    Number.isFinite(value.initializedAt) && value.initializedAt >= 0)
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
async function atomicWrite(target: string, contents: string): Promise<void> {
  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, contents, { mode: 0o600 })
  const handle = await fs.open(temporary, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, target)
  await fs.chmod(target, 0o600)
}
