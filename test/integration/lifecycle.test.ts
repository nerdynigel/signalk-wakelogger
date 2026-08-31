import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pluginConstructor from '../../src/index'
import { CredentialStore } from '../../src/pairing/credentials'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })

describe('Signal K lifecycle', () => {
  it('starts, stops and restarts safely with empty configuration and no network', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-lifecycle-'))
    directories.push(directory)
    const statuses: string[] = []
    const app: any = {
      getDataDirPath: () => directory,
      setPluginStatus: (status: string) => statuses.push(status),
      setPluginError: vi.fn(), error: vi.fn(), debug: Object.assign(vi.fn(), { enabled: false }),
      subscriptionmanager: { subscribe: vi.fn() }
    }
    const plugin = pluginConstructor(app)
    expect(plugin.schema).toMatchObject({ type: 'object' })
    plugin.start({}, vi.fn())
    await waitFor(() => statuses.includes('Wake Logger: Not paired'))
    await plugin.stop()
    expect(statuses.at(-1)).toBe('Wake Logger: Stopped')
    plugin.start({}, vi.fn())
    await waitFor(() => statuses.at(-1) === 'Wake Logger: Not paired')
    await plugin.stop()
    expect(app.setPluginError).not.toHaveBeenCalled()
  })

  it('upgrades unbound credentials once and rejects a later partial outbox-state loss', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-lifecycle-'))
    directories.push(directory)
    const credentialStore = new CredentialStore(path.join(directory, 'identity'))
    await credentialStore.save({
      version: 1, deviceId: 'dev_upgrade', clientId: 'dev_upgrade', username: 'dev_upgrade',
      password: 'a-very-long-secret', mqttHost: 'localhost', mqttPort: 1, tls: false, pairedAt: 1000
    })
    const statuses: string[] = []
    const app: any = {
      getDataDirPath: () => directory,
      setPluginStatus: (status: string) => statuses.push(status),
      setPluginError: vi.fn(), error: vi.fn(), debug: Object.assign(vi.fn(), { enabled: false }),
      subscriptionmanager: { subscribe: vi.fn() }
    }
    const plugin = pluginConstructor(app)
    plugin.start({}, vi.fn())
    await waitFor(async () => (await credentialStore.load())?.outboxBinding?.backend === 'file')
    await plugin.stop()
    expect((await credentialStore.load())?.outboxBinding).toMatchObject({ version: 1, backend: 'file' })

    await fs.unlink(path.join(directory, 'outbox', 'dev_upgrade.backend.json'))
    app.setPluginError.mockClear()
    plugin.start({}, vi.fn())
    await waitFor(() => app.setPluginError.mock.calls.some((call: string[]) =>
      typeof call[0] === 'string' && call[0].includes('refusing an unsafe sequence reset')))
    await plugin.stop()
  })
})

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for plugin state')
}
