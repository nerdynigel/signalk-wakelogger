import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mqtt from 'mqtt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pluginConstructor from '../../src/index'
import { CredentialStore } from '../../src/pairing/credentials'
import { FileOutbox } from '../../src/outbox/file-outbox'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

describe('local recording mode', () => {
  it('records paired navigation durably without MQTT or pairing traffic, including after restart', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-recording-'))
    directories.push(directory)
    const credentials = new CredentialStore(path.join(directory, 'identity'))
    await credentials.save({ version: 1, deviceId: 'dev_local', clientId: 'dev_local', username: 'dev_local', password: 'a-very-long-secret', mqttHost: 'localhost', mqttPort: 1, tls: false, pairedAt: 1000 })
    const connect = vi.spyOn(mqtt, 'connect')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    let ingest: ((delta: any) => void) | undefined
    const statuses: string[] = []
    const app: any = {
      getDataDirPath: () => directory,
      setPluginStatus: (status: string) => statuses.push(status),
      setPluginError: vi.fn(), error: vi.fn(), debug: Object.assign(vi.fn(), { enabled: false }),
      subscriptionmanager: { subscribe: (_options: unknown, _unsub: unknown, _error: unknown, callback: (delta: any) => void) => { ingest = callback } }
    }
    const plugin = pluginConstructor(app)
    const config = { uploadMode: 'local_only', pairingCode: 'DO-NOT-EXCHANGE', samplePeriodMs: 250 }
    try {
      plugin.start(config, vi.fn())
      await vi.waitFor(() => expect(statuses.at(-1)).toContain('recording_locally'))
      ingest?.({ updates: [{ timestamp: new Date().toISOString(), values: [
        { path: 'navigation.position', value: { latitude: -27, longitude: 153 } },
        { path: 'navigation.speedOverGround', value: 2 }
      ] }] })
      await vi.waitFor(async () => {
        expect(await fs.readdir(path.join(directory, 'outbox', 'dev_local'))).toContain('segment-000000000001.log')
      }, { timeout: 3000 })
      await plugin.stop()
      plugin.start(config, vi.fn())
      await vi.waitFor(() => expect(statuses.at(-1)).toContain('recording_locally'))
      await plugin.stop()
      const outbox = new FileOutbox(path.join(directory, 'outbox', 'dev_local'), { maxBytes: 1000000, maxAgeMs: 86400000, segmentBytes: 65536 })
      await outbox.open()
      const queued = await outbox.pending(10, 100000)
      expect(queued).toHaveLength(1)
      expect(queued[0]).toMatchObject({ sequence: 1, values: { lat: -27, lon: 153 }, recording: { state: 'recording', firstSequence: 1 } })
      await outbox.close()
      expect(connect).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(app.setPluginError).not.toHaveBeenCalled()
      expect(app.error).not.toHaveBeenCalled()
      plugin.start({ uploadMode: 'automatic', samplePeriodMs: 250 }, vi.fn())
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    } finally { await plugin.stop() }
  })
})
