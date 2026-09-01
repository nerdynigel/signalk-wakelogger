import type { DeviceCredentials } from './credentials'
import { validateCredentials } from './credentials'

interface PairingResponse {
  device: { id: string }
  credentials: {
    broker_host: string
    broker_port: number
    tls: boolean
    client_id: string
    username: string
    password: string
    telemetry_profile?: unknown
    association_status_url?: string
    association_token?: string
  }
}

export class PairingError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message)
    this.name = 'PairingError'
  }
}

interface PairingRequestOptions { signal?: AbortSignal }
export interface PairingRetryOptions extends PairingRequestOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  onAttempt?: (attempt: number, maxAttempts: number) => void
  onRetry?: (nextAttempt: number, maxAttempts: number, delayMs: number, error: PairingError) => void
}

export async function pairDevice(apiUrl: string, pairingCode: string, installationId: string, options: PairingRequestOptions = {}): Promise<DeviceCredentials> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    let response: Response
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code: pairingCode, name: `Signal K ${installationId.slice(0, 8)}` }),
        signal: controller.signal
      })
    } catch {
      if (options.signal?.aborted) throw new PairingError('Pairing cancelled', false)
      const timedOut = controller.signal.aborted
      throw new PairingError(timedOut ? 'Pairing request timed out' : 'Pairing service is unavailable', true)
    }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
      const message = response.status === 400
        ? 'Pairing code is invalid or expired'
        : `Pairing failed with HTTP ${response.status}`
      throw new PairingError(message, retryable, response.status)
    }
    const body = await response.json() as PairingResponse
    const credentials: DeviceCredentials = {
      version: 1,
      deviceId: body.device?.id,
      clientId: body.credentials?.client_id,
      username: body.credentials?.username,
      password: body.credentials?.password,
      mqttHost: body.credentials?.broker_host,
      mqttPort: body.credentials?.broker_port,
      tls: body.credentials?.tls,
      telemetryProfile: body.credentials?.telemetry_profile as DeviceCredentials['telemetryProfile'],
      associationStatusUrl: body.credentials?.association_status_url,
      associationToken: body.credentials?.association_token,
      pairedAt: Date.now()
    }
    if (!validateCredentials(credentials)) throw new PairingError('Pairing response failed validation', false)
    return credentials
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

export async function pairDeviceWithRetry(
  apiUrl: string,
  pairingCode: string,
  installationId: string,
  options: PairingRetryOptions = {}
): Promise<DeviceCredentials> {
  const maxAttempts = Math.max(1, Math.min(10, options.maxAttempts ?? 6))
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 2000)
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 30_000)
  let lastError = new PairingError('Pairing failed', false)
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.onAttempt?.(attempt, maxAttempts)
    try {
      return await pairDevice(apiUrl, pairingCode, installationId, { signal: options.signal })
    } catch (error) {
      lastError = error instanceof PairingError ? error : new PairingError('Pairing service is unavailable', true)
      if (!lastError.retryable || attempt >= maxAttempts || options.signal?.aborted) throw lastError
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      options.onRetry?.(attempt + 1, maxAttempts, delayMs, lastError)
      await abortableDelay(delayMs, options.signal)
    }
  }
  throw lastError
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new PairingError('Pairing cancelled', false)); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, delayMs)
    const abort = () => { clearTimeout(timer); reject(new PairingError('Pairing cancelled', false)) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
