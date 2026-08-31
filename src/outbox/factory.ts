import type { ServerAPI } from '@signalk/server-api'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DatabaseOutbox } from './database-outbox'
import type { WithSignalKDatabaseApi } from './database-types'
import { FileOutbox } from './file-outbox'
import type { OutboxOptions, OutboxSeed, OutboxStore } from './interface'

interface BackendMarker { version: 1; backend: 'file' | 'database' }

export interface SelectedOutbox { store: OutboxStore; backend: BackendMarker['backend'] }

export async function createOutbox(
  app: ServerAPI,
  dataDirectory: string,
  deviceId: string,
  options: OutboxOptions,
  expectedBackend?: BackendMarker['backend']
): Promise<SelectedOutbox> {
  const root = path.join(dataDirectory, 'outbox')
  const fileDirectory = path.join(root, deviceId)
  const markerTarget = path.join(root, `${deviceId}.backend.json`)
  const marker = await readMarker(markerTarget)
  if (expectedBackend && marker?.backend !== expectedBackend) {
    throw new Error('The bound outbox backend marker is missing or inconsistent; refusing an unsafe sequence reset')
  }
  let databaseApi
  try {
    databaseApi = (app as ServerAPI & WithSignalKDatabaseApi).getDatabaseApi?.()
  } catch (error) {
    if (marker?.backend === 'database') throw error
    databaseApi = undefined
  }

  if (marker?.backend === 'database') {
    if (!databaseApi) throw new Error('The selected Signal K Database API outbox is unavailable; refusing an unsafe sequence fallback')
    const store = new DatabaseOutbox(await databaseApi.getPluginDb('signalk-wakelogger'), deviceId, options)
    await store.open()
    return { store, backend: 'database' }
  }

  const file = new FileOutbox(fileDirectory, options)
  await file.open()
  const fileStats = await file.stats()
  if (!databaseApi || fileStats.messageCount > 0) {
    await writeMarker(markerTarget, { version: 1, backend: 'file' })
    return { store: file, backend: 'file' }
  }

  const seed: OutboxSeed = {
    currentSequence: fileStats.currentSequence,
    acknowledgedSequence: fileStats.acknowledgedSequence,
    droppedCount: fileStats.droppedCount,
    droppedThrough: fileStats.droppedThrough
  }
  let store: DatabaseOutbox
  try {
    store = new DatabaseOutbox(await databaseApi.getPluginDb('signalk-wakelogger'), deviceId, options, seed)
    await store.open()
  } catch {
    await writeMarker(markerTarget, { version: 1, backend: 'file' })
    return { store: file, backend: 'file' }
  }
  await file.close()
  await writeMarker(markerTarget, { version: 1, backend: 'database' })
  return { store, backend: 'database' }
}

async function readMarker(target: string): Promise<BackendMarker | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(target, 'utf8')) as Partial<BackendMarker>
    return value.version === 1 && (value.backend === 'file' || value.backend === 'database')
      ? value as BackendMarker
      : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function writeMarker(target: string, marker: BackendMarker): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 })
  const handle = await fs.open(temporary, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, target)
  // Windows does not support opening directories for fsync. The file flush and
  // atomic rename above still provide the strongest portable guarantee there.
  if (process.platform === 'win32') return
  const directory = await fs.open(path.dirname(target), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
