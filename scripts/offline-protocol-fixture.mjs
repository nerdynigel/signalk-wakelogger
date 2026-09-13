// Run after npm run build. Output is a deterministic wire-format regression fixture.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { RecordingStore } = require('../dist/trips/recording-store.js')
const { FileOutbox } = require('../dist/outbox/file-outbox.js')
const directory = await mkdtemp(path.join(os.tmpdir(), 'offline-protocol-'))
try {
  const baseTime = Date.UTC(2026, 8, 13, 0, 0, 0)
  const recorder = new RecordingStore(path.join(directory, 'recordings.json'))
  await recorder.open()
  const outbox = new FileOutbox(path.join(directory, 'outbox'), {
    maxBytes: 1000000, maxAgeMs: 30 * 86400000, segmentBytes: 65536, now: () => baseTime + 7200000
  })
  await outbox.open()
  const samples = []
  for (const [seconds, speed, lat] of [[0, 4, -27], [120, 4, -27.005], [300, 4, -27.01], [600, 0, -27.015], [1500, 0, -27.015], [1800, 4, -27.015], [1920, 4, -27.02]]) {
    const draft = { capturedAt: baseTime + seconds * 1000, receivedAt: baseTime + seconds * 1000, values: { lat, lon: 153, sog_kn: speed }, quality: { timestamp: 'source' } }
    await recorder.prepare(draft, samples.length + 1)
    samples.push(await outbox.append('dev_offline_fixture', draft))
  }
  const recordings = recorder.manifests()
  // Stable UUIDs make the generated fixture reviewable across runs.
  const ids = new Map(recordings.map((recording, index) => [recording.id, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]))
  const batch = (items) => ({ v: 1, deviceId: 'dev_offline_fixture', samples: items })
  const fixture = {
    provenance: { generator: 'signalk-wakelogger/scripts/offline-protocol-fixture.mjs', implementation: 'RecordingStore + FileOutbox; IDs normalized for deterministic output' },
    baseTime, recordings,
    messages: [
      { topic: 'telemetry', payload: batch([samples.at(-1)]) },
      { topic: 'status', payload: { v: 1, state: 'online', at: baseTime + 1920000, recordings, queueMessageCount: 7, currentSequence: 7, acknowledgedSequence: 0, queueDroppedCount: 0, uploadMode: 'automatic' } },
      { topic: 'telemetry', payload: batch(samples.slice(0, 3)) },
      { topic: 'telemetry', payload: batch(samples.slice(3, 6)) }
    ]
  }
  console.log(JSON.stringify(fixture, (_key, value) => typeof value === 'string' ? ids.get(value) ?? value : value, 2))
  await outbox.close()
} finally { await rm(directory, { recursive: true, force: true }) }
