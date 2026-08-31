import { performance } from 'node:perf_hooks'

const seconds = Math.max(1, Number.parseInt(process.argv[2] || '86400', 10))
const started = performance.now()
const cpuStarted = process.cpuUsage()
let onlineBytes = 0
let sampleBytes = 0

for (let sequence = 1; sequence <= seconds; sequence += 1) {
  const capturedAt = 1_788_143_912_000 + sequence * 1000
  const sample = {
    v: 1, deviceId: 'device_example', sequence, capturedAt, receivedAt: capturedAt + 50,
    trackingSessionId: 'tracking_example',
    values: { lat: -27.41238, lon: 153.18291, sog_kn: 6.42, cog_deg: 241.3, heading_deg: 238.8, heading_reference: 'true', depth_m: 12.4, aws_kn: 15.2, awa_deg: 42 },
    quality: { timestamp: 'source' }
  }
  const encodedSample = JSON.stringify(sample)
  const batch = JSON.stringify({ v: 1, deviceId: 'device_example', samples: [sample] })
  sampleBytes += Buffer.byteLength(encodedSample)
  // Normal online traffic publishes one retained current-state document and
  // one telemetry batch. Genuine backlog recovery can add a priority copy.
  onlineBytes += Buffer.byteLength(encodedSample) + Buffer.byteLength(batch)
  if (sequence % 10 === 0) onlineBytes += 520
}

const cpu = process.cpuUsage(cpuStarted)
const result = {
  simulatedSeconds: seconds,
  averageEncodedSampleBytes: Math.round(sampleBytes / seconds),
  averageFileRecordBytes: Math.round(sampleBytes / seconds) + 36,
  estimatedOutboxBytes: sampleBytes + seconds * 36,
  averageOnlineApplicationBytesPerSecond: Math.round(onlineBytes / seconds),
  targetApplicationBytesPerSecond: 1024,
  withinTarget: onlineBytes / seconds < 1024,
  benchmarkWallMilliseconds: Math.round(performance.now() - started),
  benchmarkCpuMilliseconds: Math.round((cpu.user + cpu.system) / 1000),
  peakProcessRssBytes: process.memoryUsage().rss,
  exclusions: ['MQTT packet overhead', 'TCP/IP overhead', 'TLS overhead', 'outbox I/O', 'Signal K server load']
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
