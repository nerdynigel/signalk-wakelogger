// Disposable upgrade fixture: an older plugin queued these dockside readings.
// This file is never included in the published plugin package.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const configurationRoot = process.argv[2]
if (!configurationRoot) throw new Error('Signal K configuration directory is required')
const { FileOutbox } = await import(pathToFileURL(path.join(configurationRoot, 'node_modules/signalk-wakelogger/dist/outbox/file-outbox.js')).href)
const outbox = new FileOutbox(path.join(configurationRoot, 'plugin-config-data/signalk-wakelogger/outbox/dev_docker_e2e'), {
  maxBytes: 10 * 1024 * 1024, maxAgeMs: 86400000, segmentBytes: 65536
})
await outbox.open()
const start = Date.now() - 3600000
for (let index = 0; index < 10; index++) await outbox.append('dev_docker_e2e', {
  capturedAt: start + index * 1000, receivedAt: start + index * 1000,
  values: { lat: -27.4, lon: 153.17, sog_kn: 0.05 }, quality: { timestamp: 'source' }
})
await outbox.close()
