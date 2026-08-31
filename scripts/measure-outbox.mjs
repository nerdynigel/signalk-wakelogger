import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)
if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Wake Logger measurements require Node.js 20 or newer')
const { FileOutbox } = require('../dist/outbox/file-outbox.js')
const requested = Number(process.argv[2] ?? 300)
if (!Number.isSafeInteger(requested) || requested < 1 || requested > 86_400) {
  throw new Error('Sample count must be an integer from 1 to 86400')
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wakelogger-outbox-measure-'))
const capturedStart = Date.now()
const outbox = new FileOutbox(directory, {
  maxBytes: 10 * 1024 * 1024 * 1024,
  maxAgeMs: 8 * 86_400_000,
  segmentBytes: 4 * 1024 * 1024,
  now: () => capturedStart + requested * 1000
})

let peakRss = process.memoryUsage().rss
const cpuStart = process.cpuUsage()
const wallStart = performance.now()
try {
  await outbox.open()
  for (let index = 0; index < requested; index += 1) {
    const at = capturedStart + index * 1000
    await outbox.append('measurement-device', {
      capturedAt: at,
      receivedAt: at,
      values: {
        lat: -27.4 + index / 10_000_000,
        lon: 153.1,
        sog_kn: 6.4,
        cog_deg: 241.3,
        heading_deg: 238.8,
        heading_reference: 'true',
        depth_m: 12.4,
        aws_kn: 15.2,
        awa_deg: 315
      },
      quality: { timestamp: 'source' }
    })
    if (index % 25 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  const stats = await outbox.stats()
  await outbox.close()
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  const elapsedMs = performance.now() - wallStart
  const cpu = process.cpuUsage(cpuStart)
  const bytesPerSample = stats.diskBytes / requested
  const result = {
    kind: 'accelerated-file-outbox-stress',
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    samples: requested,
    representedSeconds: requested,
    elapsedMs: rounded(elapsedMs),
    samplesPerSecond: rounded(requested / (elapsedMs / 1000)),
    cpuUserMs: rounded(cpu.user / 1000),
    cpuSystemMs: rounded(cpu.system / 1000),
    peakRssMiB: rounded(peakRss / 1024 / 1024),
    diskBytes: stats.diskBytes,
    diskBytesPerSample: rounded(bytesPerSample),
    projectedQueueMiBPerDay: rounded(bytesPerSample * 86_400 / 1024 / 1024),
    currentSequence: stats.currentSequence,
    droppedCount: stats.droppedCount
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await outbox.close().catch(() => undefined)
  await fs.rm(directory, { recursive: true, force: true })
}

function rounded(value) { return Math.round(value * 100) / 100 }
