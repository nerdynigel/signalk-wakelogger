// Disposable upgrade fixture: an older plugin queued these dockside readings.
// This file is never included in the published plugin package.
const { FileOutbox } = await import('/home/node/.signalk/node_modules/signalk-wakelogger/dist/outbox/file-outbox.js')
const outbox = new FileOutbox('/home/node/.signalk/plugin-config-data/signalk-wakelogger/outbox/dev_docker_e2e', {
  maxBytes: 10 * 1024 * 1024, maxAgeMs: 86400000, segmentBytes: 65536
})
await outbox.open()
const start = Date.now() - 3600000
for (let index = 0; index < 10; index++) await outbox.append('dev_docker_e2e', {
  capturedAt: start + index * 1000, receivedAt: start + index * 1000,
  values: { lat: -27.4, lon: 153.17, sog_kn: 0.05 }, quality: { timestamp: 'source' }
})
await outbox.close()
