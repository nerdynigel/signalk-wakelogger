import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialStore, fingerprintPairingCode, shouldExchangePairingCode } from '../../src/pairing/credentials'
import { checkAssociationStatus } from '../../src/pairing/association-client'
import { PairingError, pairDevice, pairDeviceWithRetry } from '../../src/pairing/pairing-client'
import { legacyProfile } from '../../src/telemetry/profile'

const dirs: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })

describe('pairing', () => {
  it('creates a stable installation identity and owner-only credential file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-creds-')); dirs.push(dir)
    const store = new CredentialStore(dir)
    expect(await store.installationId()).toBe(await store.installationId())
    const credentials = {
      version: 1 as const, deviceId: 'dev_1', clientId: 'dev_1', username: 'dev_1',
      password: 'a-very-long-secret', mqttHost: 'broker.example.invalid', mqttPort: 8883, tls: true, pairedAt: Date.now()
    }
    await store.save(credentials)
    expect(await store.load()).toEqual(credentials)
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600)
    }
    expect(await fs.readFile(path.join(dir, 'credentials.json'), 'utf8')).not.toContain('ABC123')
  })

  it('validates pairing responses and sends no MQTT secrets', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      device: { id: 'dev_1' },
      credentials: {
        client_id: 'dev_1', username: 'dev_1', password: 'a-very-long-secret',
        broker_host: 'broker.example.invalid', broker_port: 8883, tls: true,
        telemetry_profile: { sample_period_ms: 1000 },
        association_status_url: 'https://cloud.example.invalid/devices/dev_1/association',
        association_token: 'association-token-longer-than-32-characters'
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const credentials = await pairDevice('https://cloud.example.invalid/pair', 'ABC123', 'install-id')
    expect(credentials.deviceId).toBe('dev_1')
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(request).toEqual({ code: 'ABC123', name: 'Signal K install-' })
    expect(request.password).toBeUndefined()
    expect(credentials).toMatchObject({
      deviceId: 'dev_1', mqttHost: 'broker.example.invalid', tls: true,
      telemetryProfile: { sample_period_ms: 1000 },
      associationStatusUrl: 'https://cloud.example.invalid/devices/dev_1/association'
    })
  })

  it('retries transient pairing failures but stops on an invalid code', async () => {
    const success = new Response(JSON.stringify({
      device: { id: 'dev_retry' },
      credentials: {
        client_id: 'dev_retry', username: 'dev_retry', password: 'a-very-long-secret',
        broker_host: 'broker.example.invalid', broker_port: 8883, tls: true
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(success)
    vi.stubGlobal('fetch', fetchMock)
    const retries: number[] = []
    const paired = await pairDeviceWithRetry('https://cloud.example.invalid/pair', 'RETRY1', 'install-id', {
      maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1,
      onRetry: (attempt) => retries.push(attempt)
    })
    expect(paired.deviceId).toBe('dev_retry')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(retries).toEqual([2])

    fetchMock.mockReset().mockResolvedValue(new Response('', { status: 400 }))
    await expect(pairDeviceWithRetry('https://cloud.example.invalid/pair', 'EXPIRED', 'install-id', {
      maxAttempts: 3, baseDelayMs: 1
    })).rejects.toMatchObject({ status: 400, retryable: false } satisfies Partial<PairingError>)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('confirms a revoked association with the device-scoped status credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      v: 1, device_id: 'dev_1', status: 'revoked'
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const credentials = {
      version: 1 as const, deviceId: 'dev_1', clientId: 'dev_1', username: 'dev_1',
      password: 'a-very-long-secret', mqttHost: 'broker.example.invalid', mqttPort: 8883, tls: true, pairedAt: 1000,
      associationStatusUrl: 'https://cloud.example.invalid/devices/dev_1/association',
      associationToken: 'association-token-longer-than-32-characters'
    }
    expect(await checkAssociationStatus(credentials)).toBe('revoked')
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toMatch(/^Bearer /)
  })

  it('replaces credentials for a new code but does not retry a consumed code after restart', () => {
    const credentials: any = {
      version: 1, deviceId: 'dev_1', pairingCodeFingerprint: fingerprintPairingCode('USED-CODE')
    }
    expect(shouldExchangePairingCode(credentials, 'USED-CODE')).toBe(false)
    expect(shouldExchangePairingCode(credentials, 'REPLACEMENT-CODE')).toBe(true)
    expect(credentials.pairingCodeFingerprint).not.toContain('USED-CODE')
  })

  it('accepts an earlier telemetry profile and upgrades it to the current managed shape', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-creds-')); dirs.push(dir)
    const store = new CredentialStore(dir)
    await store.save({
      version: 1, deviceId: 'dev_legacy', clientId: 'dev_legacy', username: 'dev_legacy',
      password: 'a-very-long-secret', mqttHost: 'broker.example.invalid', mqttPort: 8883,
      tls: true, pairedAt: 1000, telemetryProfile: { sample_period_ms: 2000, batch_size: 30 }
    })
    const loaded = await store.load()
    expect(loaded?.telemetryProfile).toEqual({ sample_period_ms: 2000, batch_size: 30 })
    const upgraded = legacyProfile(2000, 30)
    expect(upgraded.transport.batchSize).toBe(30)
    expect(upgraded.paths.position.normalMs).toBe(2000)
    expect(Object.keys(upgraded.paths).sort()).toEqual(['apparentWind', 'cog', 'depth', 'heading', 'position', 'sog'])
  })

  it('persists the outbox backend binding used to prevent sequence resets', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-creds-')); dirs.push(dir)
    const store = new CredentialStore(dir)
    await store.save({
      version: 1, deviceId: 'dev_bound', clientId: 'dev_bound', username: 'dev_bound',
      password: 'a-very-long-secret', mqttHost: 'broker.example.invalid', mqttPort: 8883,
      tls: true, pairedAt: 1000,
      outboxBinding: { version: 1, backend: 'file', initializedAt: 2000 }
    })
    expect((await store.load())?.outboxBinding).toEqual({ version: 1, backend: 'file', initializedAt: 2000 })
  })

  it('forgets credentials without deleting retired outbox or replaying the consumed code', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-creds-')); dirs.push(root)
    const dir = path.join(root, 'identity')
    const outboxFile = path.join(root, 'outbox', 'dev_forgotten', '00000001.wlq')
    await fs.mkdir(path.dirname(outboxFile), { recursive: true })
    await fs.writeFile(outboxFile, 'preserved sequence records')
    const store = new CredentialStore(dir)
    const fingerprint = fingerprintPairingCode('USED-CODE')
    await store.save({
      version: 1, deviceId: 'dev_forgotten', clientId: 'dev_forgotten', username: 'dev_forgotten',
      password: 'a-very-long-secret', mqttHost: 'broker.example.invalid', mqttPort: 8883,
      tls: true, pairedAt: 1000, pairingCodeFingerprint: fingerprint,
      outboxBinding: { version: 1, backend: 'file', initializedAt: 2000 }
    })
    expect(await store.forget()).toEqual({ forgotten: true, deviceId: 'dev_forgotten' })
    expect(await store.load()).toBeUndefined()
    expect(await fs.readFile(outboxFile, 'utf8')).toBe('preserved sequence records')
    expect(shouldExchangePairingCode(undefined, 'USED-CODE', await store.lastPairingCodeFingerprint())).toBe(false)
    expect(shouldExchangePairingCode(undefined, 'NEW-CODE', await store.lastPairingCodeFingerprint())).toBe(true)
  })
})
