// Real Mosquitto integration E2E for the Wake Logger Race Pack lifecycle.
//
// Uses a disposable Mosquitto broker with per-device authentication and ACLs
// (equivalent isolation to the runtime dynamic-security roles) and the actual
// compiled plugin components: WakeLoggerTransport, RacePackReceiver,
// RacePackStore, OnboardSnapshotStore, topic helpers and reconnect behaviour.
//
// The "cloud" peer speaks the frozen wire protocol (retained manifest/chunks,
// retained race-pack-ack, events + application ack). The canonical framing is
// asserted against the Python cloud in api/tests/test_signalk_race_pack_golden.py.
//
// Usage: node scripts/test-broker-e2e.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import mqtt from 'mqtt'
import { gzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const dist = (name) => require(path.join(root, 'dist', name))
const { WakeLoggerTransport } = dist('transport/mqtt-client')
const { RacePackReceiver } = dist('race/race-pack-protocol')
const { RacePackStore } = dist('race/race-pack-store')
const { OnboardSnapshotStore } = dist('race/onboard-store')
const { FileOutbox } = dist('outbox/file-outbox')
const { DEFAULT_TELEMETRY_PROFILE } = dist('telemetry/profile')

const MOSQUITTO_IMAGE = process.env.WAKELOGGER_E2E_MOSQUITTO || 'eclipse-mosquitto@sha256:6f8d8a947c506f8a2290ec65cd4bd2bc7cb4d43fb5f6271f861cb013e2ef9797'
const CLOUD_USER = 'cloud'
const PASSWORD = 'broker-e2e-secret-01'
const results = []
let failures = 0

function check(name, condition, detail = '') {
  if (condition) { results.push(`PASS  ${name}`) } else { failures += 1; results.push(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  return result
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

function writeBrokerConfig(directory) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'mosquitto.conf'), [
    'per_listener_settings false',
    'listener 1883 0.0.0.0',
    'allow_anonymous false',
    'password_file /mosquitto/config/passwd',
    'acl_file /mosquitto/config/acl'
  ].join('\n'))
  const acl = [
    `user ${CLOUD_USER}`,
    'topic readwrite wakelogger/v1/devices/#',
    '',
    'user device-a',
    'topic read wakelogger/v1/devices/device-a/#',
    'topic write wakelogger/v1/devices/device-a/#',
    '',
    'user device-b',
    'topic read wakelogger/v1/devices/device-b/#',
    'topic write wakelogger/v1/devices/device-b/#',
    ''
  ].join('\n')
  writeFileSync(path.join(directory, 'acl'), acl)
  const script = [
    `mosquitto_passwd -b -c /w/passwd ${CLOUD_USER} ${PASSWORD}`,
    `mosquitto_passwd -b /w/passwd device-a ${PASSWORD}`,
    `mosquitto_passwd -b /w/passwd device-b ${PASSWORD}`,
    'chmod 0755 /w && chmod 0644 /w/mosquitto.conf /w/acl /w/passwd'
  ].join(' && ')
  const result = docker(['run', '--rm', '--user', 'root', '-v', `${directory}:/w`, MOSQUITTO_IMAGE, 'sh', '-c', script])
  if (result.status !== 0) throw new Error(`passwd generation failed: ${result.stderr}`)
}

function encodePack(pack, { packId, revision, chunkCount = 2 }) {
  const canonical = Buffer.from(JSON.stringify(pack), 'utf8')
  const sha256 = createHash('sha256').update(canonical).digest('hex')
  const base64 = gzipSync(canonical, { mtime: 0 }).toString('base64')
  const groups = base64.match(/.{1,4}/g) ?? []
  const requested = Math.max(1, chunkCount)
  const per = Math.max(1, Math.ceil(groups.length / requested))
  const parts = []
  for (let index = 0; index < requested; index += 1) parts.push(groups.slice(index * per, (index + 1) * per).join(''))
  const id = packId ?? pack.packId
  const manifest = { v: 1, packId: id, revision: revision ?? pack.revision, racePlanId: pack.racePlanId ?? null, generatedAt: pack.generatedAt, validFrom: pack.validFrom ?? null, validUntil: pack.validUntil ?? null, ruleSetVersion: pack.ruleSetVersion, encoding: 'gzip+base64', chunkCount: parts.length, sha256 }
  const chunks = parts.map((data, index) => ({ v: 1, packId: id, revision: manifest.revision, index, chunkCount: parts.length, data }))
  return { manifest, chunks, sha256, canonical, packId: id, revision: manifest.revision }
}

function waitFor(description, predicate, timeoutMs = 15000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    while (Date.now() < deadline) {
      if (await predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    throw new Error(`Timed out waiting for ${description}`)
  })()
}

function connect(url, username, password, clientId) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { protocolVersion: 5, username, password, clientId, clean: true, reconnectPeriod: 0, connectTimeout: 8000 })
    client.once('connect', () => resolve(client))
    client.once('error', (error) => reject(error))
  })
}

function subscribe(client, topic) {
  return new Promise((resolve, reject) => client.subscribe(topic, { qos: 1 }, (error, granted) => error ? reject(error) : resolve(granted)))
}

function publish(client, topic, payload, options = { qos: 1 }) {
  return new Promise((resolve, reject) => client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), options, (error) => error ? reject(error) : resolve()))
}

function endClient(client) {
  return new Promise((resolve) => client.end(false, {}, () => resolve()))
}

function buildPack(revision, packId = `pack-777-${revision}`) {
  const now = Date.now()
  const samples = (hour) => ({ time: new Date(now + hour * 3600000).toISOString(), twd_deg: 350, tws_knots: 12, gust_knots: 15, current_velocity_kn: 0.4, current_direction_deg: 200 })
  const points = [
    { id: 'p1', name: 'Start', latitude: -27.4, longitude: 153.17, kind: 'start', rounding: 'either' },
    { id: 'p2', name: 'Mark 1', latitude: -27.4, longitude: 153.22, kind: 'mark', rounding: 'starboard' },
    { id: 'p3', name: 'Finish', latitude: -27.36, longitude: 153.22, kind: 'finish', rounding: 'either' }
  ]
  const legs = [1, 2].map((sequence, index) => ({ sequence, latitude: points[index].latitude, longitude: points[index].longitude, samples: [samples(-1), samples(0), samples(1)] }))
  return {
    v: 1, kind: 'race_pack', packId, revision, racePlanId: 777, generatedAt: new Date(now - 3600000).toISOString(),
    validFrom: new Date(now - 3600000).toISOString(), validUntil: new Date(now + 6 * 3600000).toISOString(),
    ruleSetVersion: 'race_plan_dynamic_v1',
    course: { courseId: 'race-plan-777', racePlanId: 777, name: 'Broker E2E', points },
    courseDefinitionDigest: 'a'.repeat(64),
    sails: [{ id: 1, sail_name: 'Mainsail', sail_type: 'Mainsail', availability_status: 'Available', is_available: true, archived_at: null }],
    raceHeadsail: null,
    payload: { startTime: new Date(now).toISOString(), availableCrewCount: 4, jibChangesAllowed: false },
    vesselPerformance: { hullSpeedKnots: 7, lengthWaterlineM: 10, lengthM: 12 },
    forecast: { snapshot: { provider: 'e2e' }, coverage: { from: new Date(now - 3600000).toISOString(), until: new Date(now + 6 * 3600000).toISOString() }, legs },
    polarSummary: { eligible: false }
  }
}

function buildSnapshot(id, trackingSessionId) {
  const now = Date.now()
  return {
    v: 1, kind: 'race_plan_snapshot', id, generatedAt: now, source: 'onboard', packId: 'pack-777-4', packRevision: 4, packSha256: 'a'.repeat(64), ruleSetVersion: 'race_plan_dynamic_v1',
    tracking: { trackingSessionId, courseId: 'race-plan-777', racePlanId: 777, activeIndex: 1, totalPoints: 3, reverse: false },
    observations: { twsKnots: 12, twdDeg: 350, gustKnots: 15, headingDeg: 10, cogDeg: 10, sogKnots: 6, stwKnots: 6, heelDeg: 5, awsKnots: 18, awaDeg: 30, sampleCount: 40, windowSeconds: 300, windSource: 'true', qualifyingSampleCount: 40, coveredSeconds: 280, latestSampleAgeSeconds: 2 },
    position: { latitude: -27.395, longitude: 153.18 }, activeLegSequence: 1, completedLegCount: 0,
    estimatedFinishAt: new Date(now + 3600000).toISOString(), remainingDurationSeconds: 3600, legCount: 2, forecastCoverage: 'complete', warning: null,
    plan: { v: 1, packId: 'pack-777-4', packRevision: 4, ruleSetVersion: 'race_plan_dynamic_v1', courseId: 'race-plan-777', racePlanId: 777, courseDefinitionDigest: 'a'.repeat(64), activeLegSequence: 1, completedLegCount: 0, estimatedFinishAt: null, remainingDurationSeconds: null, forecastCoverage: 'complete', warnings: [], observed: null, legs: [] }
  }
}

async function main() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wakelogger-broker-e2e-'))
  const container = `wakelogger-broker-e2e-${process.pid}`
  const port = await freePort()
  const url = `mqtt://127.0.0.1:${port}`
  let cloud
  let transport
  let observed = []
  const outboxDirectories = []
  try {
    writeBrokerConfig(directory)
    const started = docker(['run', '-d', '--name', container, '-p', `127.0.0.1:${port}:1883`, '-v', `${realpathSync(directory)}:/mosquitto/config:ro`, MOSQUITTO_IMAGE, 'mosquitto', '-c', '/mosquitto/config/mosquitto.conf'])
    if (started.status !== 0) throw new Error(`broker start failed: ${started.stderr}`)
    try {
      await waitFor('broker readiness', async () => { try { const probe = await connect(url, CLOUD_USER, PASSWORD, `probe-${process.pid}-${Date.now()}`); await endClient(probe); return true } catch { return false } })
    } catch (error) {
      const logs = docker(['logs', container], { stdio: 'pipe' })
      throw new Error(`${error.message}\nbroker logs:\n${logs.stdout}\n${logs.stderr}`)
    }
    cloud = await connect(url, CLOUD_USER, PASSWORD, `cloud-${process.pid}`)
    check('broker accepts authenticated cloud client', !!cloud)

    const deviceTopics = (id) => `wakelogger/v1/devices/${id}`
    const cloudMessages = []
    await subscribe(cloud, `wakelogger/v1/devices/#`)
    cloud.on('message', (topic, payload) => {
      const text = payload.toString('utf8')
      cloudMessages.push({ topic, payload: text })
      if (topic.endsWith('/telemetry')) {
        try {
          const batch = JSON.parse(text)
          const through = batch.samples?.at(-1)?.sequence
          if (through) void publish(cloud, `${deviceTopics('device-a')}/ack`, JSON.stringify({ v: 1, deviceId: 'device-a', ackSequence: through }))
        } catch { /* ignore */ }
      }
    })

    // --- Device isolation: device-a cannot read device-b topics. ---
    const spyA = await connect(url, 'device-a', PASSWORD, `a-spy-${process.pid}`)
    const spyMessages = []
    spyA.on('message', (topic) => spyMessages.push(topic))
    await subscribe(spyA, `wakelogger/v1/devices/device-b/#`).catch(() => undefined)
    await publish(cloud, `${deviceTopics('device-b')}/state`, JSON.stringify({ v: 1, sequence: 1 }), { qos: 1, retain: false })
    await new Promise((resolve) => setTimeout(resolve, 400))
    check('Device A cannot subscribe/read Device B Race Pack topics', spyMessages.length === 0)
    // Device A cannot publish Device B ACK: the broker denies it and the cloud never sees it.
    cloudMessages.length = 0
    await publish(spyA, `${deviceTopics('device-b')}/race-pack-ack`, JSON.stringify({ v: 1, packId: 'x', revision: 1, sha256: 'f'.repeat(64), status: 'applied' })).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 400))
    check('Device A cannot publish Device B ACK', !cloudMessages.some((entry) => entry.topic.endsWith('device-b/race-pack-ack')))
    await endClient(spyA)

    // --- Real plugin transport for device-a. ---
    const outboxDirectory = mkdtempSync(path.join(os.tmpdir(), 'wakelogger-outbox-'))
    outboxDirectories.push(outboxDirectory)
    const outbox = new FileOutbox(outboxDirectory, { maxBytes: 1_000_000, maxAgeMs: 3_600_000, segmentBytes: 4096 })
    await outbox.open()
    const packDirectory = mkdtempSync(path.join(os.tmpdir(), 'wakelogger-packs-'))
    outboxDirectories.push(packDirectory)
    const store = new RacePackStore(packDirectory)
    await store.open()
    const receiver = new RacePackReceiver({ store })
    const snapshotDirectory = mkdtempSync(path.join(os.tmpdir(), 'wakelogger-snaps-'))
    outboxDirectories.push(snapshotDirectory)
    const snapshots = new OnboardSnapshotStore(path.join(snapshotDirectory, 'state.json'))
    await snapshots.open()
    const credentials = { version: 1, deviceId: 'device-a', clientId: 'device-a', username: 'device-a', password: PASSWORD, mqttHost: '127.0.0.1', mqttPort: port, tls: false, pairedAt: Date.now() }
    const makeTransport = () => new WakeLoggerTransport(credentials, outbox, {
      profile: DEFAULT_TELEMETRY_PROFILE,
      onState: () => undefined,
      onRacePackManifest: async (payload) => receiver.acceptManifest(payload),
      onRacePackChunk: async (payload, topicIndex) => receiver.acceptChunk(payload, topicIndex),
      getRacePackAck: () => receiver.currentAck(),
      onRacePlanSnapshotAcks: async (ids) => { await snapshots.acknowledge(ids) }
    })
    transport = makeTransport()
    transport.start()
    await waitFor('device-a online', () => Promise.resolve(cloudMessages.some((entry) => entry.topic.endsWith('device-a/status') && entry.payload.includes('online'))))

    // --- Cloud publishes chunks out of order then the manifest. ---
    const pack = buildPack(4)
    const encoded = encodePack(pack, { packId: `pack-777-4`, revision: 4, chunkCount: 3 })
    for (const chunk of [encoded.chunks[2], encoded.chunks[0], encoded.chunks[1]]) await publish(cloud, `${deviceTopics('device-a')}/race-pack/chunk/${chunk.index}`, JSON.stringify(chunk), { qos: 1, retain: true })
    await publish(cloud, `${deviceTopics('device-a')}/race-pack/manifest`, JSON.stringify(encoded.manifest), { qos: 1, retain: true })
    await waitFor('pack applied', () => Promise.resolve(store.applied()?.revision === 4))
    check('out-of-order retained delivery assembles and stores the validated pack', store.applied()?.packId === 'pack-777-4')
    await waitFor('race-pack ACK', () => Promise.resolve(cloudMessages.some((entry) => entry.topic.endsWith('device-a/race-pack-ack') && JSON.parse(entry.payload).status === 'applied')))
    check('plugin publishes applied Race Pack ACK', true)

    // --- Reconnect re-advertises the applied ACK. ---
    cloudMessages.length = 0
    await transport.stop(false)
    transport = makeTransport()
    transport.start()
    await waitFor('re-advertised ACK', () => Promise.resolve(cloudMessages.some((entry) => entry.topic.endsWith('device-a/race-pack-ack'))))
    check('reconnect re-advertises applied ACK', true)

    // --- Stale manifest cannot roll back. ---
    const stale = encodePack(buildPack(3, 'pack-777-3'), { revision: 3, packId: 'pack-777-3', chunkCount: 1 })
    for (const chunk of stale.chunks) await publish(cloud, `${deviceTopics('device-a')}/race-pack/chunk/${chunk.index}`, JSON.stringify(chunk), { qos: 1, retain: true })
    await publish(cloud, `${deviceTopics('device-a')}/race-pack/manifest`, JSON.stringify(stale.manifest), { qos: 1, retain: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    check('stale Race Pack ACK/revision cannot promote a newer applied revision', store.applied()?.revision === 4)

    // --- Malformed pack rejected and old pack retained. ---
    const bad = encodePack(buildPack(6, 'pack-777-6'), { revision: 6, packId: 'pack-777-6', chunkCount: 1 })
    const corrupted = { ...bad.chunks[0], data: bad.chunks[0].data.slice(0, -8) + 'AAAA' }
    await publish(cloud, `${deviceTopics('device-a')}/race-pack/chunk/0`, JSON.stringify(corrupted), { qos: 1, retain: true })
    await publish(cloud, `${deviceTopics('device-a')}/race-pack/manifest`, JSON.stringify(bad.manifest), { qos: 1, retain: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    check('malformed/bad digest pack rejected and old valid pack retained', store.applied()?.revision === 4)

    // --- Clear/tombstone. ---
    const clearManifest = { v: 1, action: 'clear', revision: 5, generatedAt: new Date().toISOString(), reason: 'deselected' }
    await publish(cloud, `${deviceTopics('device-a')}/race-pack/manifest`, JSON.stringify(clearManifest), { qos: 1, retain: true })
    await waitFor('cleared store', () => Promise.resolve(store.clearedRevision() === 5))
    check('cloud clear/tombstone clears durably', store.applied() === null && store.current() === null)
    await waitFor('clear ACK', () => Promise.resolve(cloudMessages.some((entry) => entry.topic.endsWith('device-a/race-pack-ack') && JSON.parse(entry.payload).action === 'clear')))
    check('plugin ACKs the clear', true)
    // Stale old pack cannot resurrect.
    for (const chunk of encoded.chunks) await publish(cloud, `${deviceTopics('device-a')}/race-pack/chunk/${chunk.index}`, JSON.stringify(chunk), { qos: 1, retain: true })
    await publish(cloud, `${deviceTopics('device-a')}/race-pack/manifest`, JSON.stringify(encoded.manifest), { qos: 1, retain: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    check('stale old pack/chunks do not resurrect after clear', store.applied() === null)
    // New pack after clear.
    const newer = encodePack(buildPack(7, 'pack-777-7'), { revision: 7, packId: 'pack-777-7', chunkCount: 2 })
    for (const chunk of newer.chunks) await publish(cloud, `${deviceTopics('device-a')}/race-pack/chunk/${chunk.index}`, JSON.stringify(chunk), { qos: 1, retain: true })
    await publish(cloud, `${deviceTopics('device-a')}/race-pack/manifest`, JSON.stringify(newer.manifest), { qos: 1, retain: true })
    await waitFor('new pack applied after clear', () => Promise.resolve(store.applied()?.revision === 7))
    check('new pack after clear applies normally', true)

    // --- Delayed onboard snapshot + application ACK. ---
    const snapshotId = `pack-777-4:${Date.now()}`
    const snapshot = buildSnapshot(snapshotId, 'session-broker-e2e')
    const snapshotSequence = await snapshots.append(snapshot, Date.now())
    await transport.publishRacePlanSnapshot(snapshot)
    await snapshots.markPublished([snapshotSequence])
    await waitFor('cloud received snapshot', () => Promise.resolve(cloudMessages.some((entry) => entry.topic.endsWith('device-a/events') && entry.payload.includes('race_plan_snapshot'))))
    check('delayed onboard snapshot publishes over real broker', true)
    // Disconnect/restart before the application ACK: the snapshot stays durable.
    cloudMessages.length = 0
    await transport.stop(false)
    transport = makeTransport()
    transport.start()
    await waitFor('device-a reconnected after restart', () => Promise.resolve(cloudMessages.some((entry) => entry.topic.endsWith('device-a/status') && entry.payload.includes('online'))))
    check('disconnect/restart before snapshot ACK keeps it durable', snapshots.unacknowledged().some((event) => event.snapshot.id === snapshotId))
    await transport.publishRacePlanSnapshot(snapshot)
    await waitFor('snapshot re-published after restart', () => Promise.resolve(cloudMessages.some((entry) => entry.topic.endsWith('device-a/events') && entry.payload.includes(snapshotId))))
    check('snapshot retries after restart', true)
    await publish(cloud, `${deviceTopics('device-a')}/ack`, JSON.stringify({ v: 1, deviceId: 'device-a', ackSequence: 0, racePlanSnapshotAcks: [{ id: snapshotId }] }), { qos: 1, retain: true })
    await waitFor('snapshot acknowledged', () => Promise.resolve(!snapshots.unacknowledged().some((event) => event.snapshot.id === snapshotId) && !snapshots.pending().some((event) => event.snapshot.id === snapshotId)))
    check('cloud application ACK marks the snapshot acknowledged', true)

    // --- Telemetry drains and ACKs. ---
    let queued
    for (let sequence = 1; sequence <= 3; sequence += 1) queued = await outbox.append('device-a', { capturedAt: sequence * 1000, receivedAt: sequence * 1000, values: { lat: -27.4, lon: 153.17, sog_kn: 6 }, quality: { timestamp: 'source' } })
    transport.updateCurrent(queued)
    await waitFor('telemetry drained', async () => (await outbox.stats()).acknowledgedSequence === 3)
    check('ordinary telemetry still drains/ACKs during the same environment', true)

    // --- Local-only final status + silence. ---
    cloudMessages.length = 0
    await transport.publishFinalLocalOnlyStatus()
    await transport.stop(false)
    await waitFor('local_only retained status', () => Promise.resolve(cloudMessages.some((entry) => entry.topic.endsWith('device-a/status') && entry.payload.includes('local_only'))))
    const localOnly = cloudMessages.find((entry) => entry.topic.endsWith('device-a/status') && entry.payload.includes('local_only'))
    check('local_only final retained status is visible before disconnect', JSON.parse(localOnly.payload).uploadMode === 'local_only')
    await new Promise((resolve) => setTimeout(resolve, 600))
    const leaked = cloudMessages.filter((entry) => /(telemetry|state|events|race-pack-ack)$/.test(entry.topic))
    check('no plugin Wake Logger traffic while local_only', leaked.length === 0)
  } catch (error) {
    failures += 1
    results.push(`FAIL  unexpected error — ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    try { await transport?.stop(false) } catch { /* ignore */ }
    try { await endClient(cloud) } catch { /* ignore */ }
    docker(['rm', '-f', container], { stdio: 'ignore' })
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* ignore */ }
    for (const dir of outboxDirectories) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }

  process.stdout.write(`${results.join('\n')}\n`)
  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${results.filter((line) => line.startsWith('PASS')).length} passed, ${failures} failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
