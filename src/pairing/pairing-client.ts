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
  }
}

export async function pairDevice(apiUrl: string, pairingCode: string, installationId: string): Promise<DeviceCredentials> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: pairingCode, name: `Signal K ${installationId.slice(0, 8)}` }),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`Pairing failed with HTTP ${response.status}`)
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
      pairedAt: Date.now()
    }
    if (!validateCredentials(credentials)) throw new Error('Pairing response failed validation')
    return credentials
  } finally {
    clearTimeout(timeout)
  }
}
