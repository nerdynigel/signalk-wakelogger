import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOutbox } from '../../src/outbox/factory'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('createOutbox', () => {
  it('uses the portable file implementation when the emerging Database API is absent', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-factory-'))
    temporaryDirectories.push(directory)
    const selected = await createOutbox({} as any, directory, 'device-1', { maxBytes: 1_000_000, maxAgeMs: 86_400_000, segmentBytes: 1024 })
    expect(selected.backend).toBe('file')
    expect((await selected.store.stats()).storageBackend).toBe('file')
    await selected.store.close()
  })

  it('refuses to silently switch sequence storage after Database API selection', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-factory-'))
    temporaryDirectories.push(directory)
    await fs.mkdir(path.join(directory, 'outbox'), { recursive: true })
    await fs.writeFile(path.join(directory, 'outbox', 'device-1.backend.json'), '{"version":1,"backend":"database"}\n')
    await expect(createOutbox({} as any, directory, 'device-1', { maxBytes: 1_000_000, maxAgeMs: 86_400_000, segmentBytes: 1024 }))
      .rejects.toThrow('refusing an unsafe sequence fallback')
  })

  it('refuses to recreate sequence state when credentials are bound but the backend marker is lost', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-factory-'))
    temporaryDirectories.push(directory)
    await expect(createOutbox(
      {} as any,
      directory,
      'device-1',
      { maxBytes: 1_000_000, maxAgeMs: 86_400_000, segmentBytes: 1024 },
      'file'
    )).rejects.toThrow('refusing an unsafe sequence reset')
  })

  it('uses the credential-bound backend when its durable marker agrees', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-factory-'))
    temporaryDirectories.push(directory)
    const first = await createOutbox({} as any, directory, 'device-1', { maxBytes: 1_000_000, maxAgeMs: 86_400_000, segmentBytes: 1024 })
    await first.store.close()
    const rebound = await createOutbox(
      {} as any,
      directory,
      'device-1',
      { maxBytes: 1_000_000, maxAgeMs: 86_400_000, segmentBytes: 1024 },
      'file'
    )
    expect(rebound.backend).toBe('file')
    await rebound.store.close()
  })
})
