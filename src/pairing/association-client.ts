import type { DeviceCredentials } from './credentials'

export type AssociationStatus = 'active' | 'revoked' | 'unknown'

export async function checkAssociationStatus(credentials: DeviceCredentials, signal?: AbortSignal): Promise<AssociationStatus> {
  if (!credentials.associationStatusUrl || !credentials.associationToken) return 'unknown'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(credentials.associationStatusUrl, {
      headers: { accept: 'application/json', authorization: `Bearer ${credentials.associationToken}` },
      signal: controller.signal
    })
    if (!response.ok) return 'unknown'
    const body = await response.json() as { v?: unknown; device_id?: unknown; status?: unknown }
    if (body.v !== 1 || body.device_id !== credentials.deviceId) return 'unknown'
    return body.status === 'revoked' ? 'revoked' : body.status === 'active' ? 'active' : 'unknown'
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
