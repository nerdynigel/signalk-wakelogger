// Production-like Mosquitto dynamic-security E2E for the Wake Logger Race Pack
// lifecycle. Uses a disposable Mosquitto dynsec broker, the ACTUAL Wake Logger
// Python provisioning/framing/ACK-ingestion functions (via the API image), and
// the real compiled plugin components as Device A/B.
//
// Usage: node scripts/test-broker-dynsec-e2e.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import mqtt from 'mqtt'

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
const API_IMAGE = process.env.WAKELOGGER_E2E_API_IMAGE || 'wakelogger-api'
const API_DIRECTORY = process.env.WAKELOGGER_API_DIR || path.join(root, '..', 'wakelogger', 'api')
const DRIVER = path.join(API_DIRECTORY, '..', 'test', 'docker', 'dynsec-cloud-driver.py')
const ADMIN = 'admin'
const ADMIN_PASSWORD = 'dynadminpw-01'
const DEVICE_PASSWORDS = { 'device-a': 'device-pw-a-0001', 'device-b': 'device-pw-b-0002' }
const CLOUD_USER = 'cloud-observer'
const CLOUD_PASSWORD = 'cloud-observer-pw-0001'
const DB_PASSWORD = process.env.WAKELOGGER_TEST_DB_PASSWORD || ''
const results = []
let failures = 0

function check(name, condition, detail = '') {
  if (condition) results.push(`PASS  ${name}`)
  else { failures += 1; results.push(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  return result
}
function freePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) }) })
}
function waitFor(description, predicate, timeoutMs = 15000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    while (Date.now() < deadline) { if (await predicate()) return true; await new Promise((r) => setTimeout(r, intervalMs)) }
    throw new Error(`Timed out waiting for ${description}`)
  })()
}
function connect(url, username, password, clientId) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, { protocolVersion: 5, username, password, clientId, clean: true, reconnectPeriod: 0, connectTimeout: 8000 })
    const timer = setTimeout(() => { client.end(true); reject(new Error(`connect timeout for ${username}`)) }, 12000)
    client.once('connect', () => { clearTimeout(timer); resolve(client) })
    client.once('error', (error) => { clearTimeout(timer); reject(new Error(`${username}: ${error.message}`)) })
  })
}
function subscribe(client, topic) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('subscribe timeout')), 8000); client.subscribe(topic, { qos: 1 }, (error, granted) => { clearTimeout(timer); if (error) return reject(error); const entries = Array.isArray(granted) ? granted : [granted]; if (entries.some((entry) => entry && entry.qos === 128)) return reject(new Error('subscribe not authorized')); resolve(granted) }) }) }
function publish(client, topic, payload, options = { qos: 1 }) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`publish timeout ${topic}`)), 8000); client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), options, (error) => { clearTimeout(timer); error ? reject(error) : resolve() }) }) }
function endClient(client) { return new Promise((resolve) => client.end(false, {}, () => resolve())) }
function readRetained(client, topic, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const onMessage = (incoming, payload) => { if (incoming !== topic) return; clearTimeout(timer); client.removeListener('message', onMessage); resolve(payload.toString('utf8')) }
    const timer = setTimeout(() => { client.removeListener('message', onMessage); resolve(null) }, timeoutMs)
    client.on('message', onMessage); client.subscribe(topic, { qos: 1 }, () => undefined)
  })
}

function runDriver(mode, bundle, bundlePath, extraMounts = [], extraEnv = []) {
  writeFileSync(bundlePath, JSON.stringify(bundle))
  const args = ['run', '--rm', '--network', 'host',
    '-v', `${API_DIRECTORY}/app:/app/app:ro`,
    '-v', `${DRIVER}:/driver.py:ro`,
    '-v', `${path.dirname(bundlePath)}:/bundle`,
    ...extraMounts,
    '-e', 'MQTT_INGESTION_ENABLED=true', '-e', 'MQTT_TLS_ENABLED=false', '-e', 'PYTHONPATH=/app',
    '-e', `MQTT_BROKER_HOST=${process.env.WAKELOGGER_E2E_BROKER_HOST || '127.0.0.1'}`,
    '-e', `MQTT_BROKER_PORT=${process.env.WAKELOGGER_E2E_BROKER_PORT || ''}`,
    '-e', `MQTT_BROKER_USERNAME=${ADMIN}`, '-e', `MQTT_BROKER_PASSWORD=${ADMIN_PASSWORD}`,
    '-e', `DATABASE_URL=${process.env.WAKELOGGER_TEST_DATABASE_URL || ''}`,
    ...extraEnv,
    '-w', '/app', API_IMAGE, 'python', '/driver.py', mode, '/bundle/bundle.json']
  const result = docker(args)
  if (result.status !== 0) return { error: (result.stderr || result.stdout || '').trim().slice(0, 400) }
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1)
  try { return JSON.parse(line) } catch { return { error: `unparseable driver output: ${line}` } }
}

async function main() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wakelogger-dynsec-e2e-'))
  const bundleDirectory = mkdtempSync(path.join(os.tmpdir(), 'wakelogger-dynsec-bundle-'))
  const bundlePath = path.join(bundleDirectory, 'bundle.json')
  const container = `wakelogger-dynsec-e2e-${process.pid}`
  const port = await freePort()
  const url = `mqtt://127.0.0.1:${port}`
  process.env.WAKELOGGER_E2E_BROKER_HOST = '127.0.0.1'
  process.env.WAKELOGGER_E2E_BROKER_PORT = String(port)
  const outboxDirectories = []
  const workerClients = []
  let transport

  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'mosquitto.conf'), [
      'per_listener_settings false', 'listener 1883 0.0.0.0', 'allow_anonymous false',
      'plugin /usr/lib/mosquitto_dynamic_security.so', 'plugin_opt_config_file /mosquitto/config/dynamic-security.json', ''
    ].join('\n'))
    // Initialise a disposable dynsec config with an admin/provisioner identity.
    const init = docker(['run', '--rm', '--user', 'root', '-v', `${directory}:/cfg`, MOSQUITTO_IMAGE, 'sh', '-c', `mosquitto_ctrl dynsec init /cfg/dynamic-security.json ${ADMIN} ${ADMIN_PASSWORD} >/dev/null 2>&1 || true; chown -R 1883:1883 /cfg; chmod 0700 /cfg; chmod 0600 /cfg/dynamic-security.json; chmod 0644 /cfg/mosquitto.conf`])
    if (init.status !== 0) throw new Error(`dynsec init failed: ${init.stderr}`)
    const started = docker(['run', '-d', '--name', container, '-p', `127.0.0.1:${port}:1883`, '-v', `${realpathSync(directory)}:/mosquitto/config`, MOSQUITTO_IMAGE, 'mosquitto', '-c', '/mosquitto/config/mosquitto.conf'])
    if (started.status !== 0) throw new Error(`dynsec broker start failed: ${started.stderr}`)
    try {
      await waitFor('dynsec broker readiness', async () => { try { const probe = await connect(url, ADMIN, ADMIN_PASSWORD, `probe-${process.pid}-${Date.now()}`); await endClient(probe); return true } catch { return false } })
    } catch (error) {
      const logs = docker(['logs', container], { stdio: 'pipe' })
      throw new Error(`${error.message}\n${logs.stdout}\n${logs.stderr}`)
    }
    check('dynsec config initialises and provisioner authenticates', true)

    // --- Actual Wake Logger provisioning (worker role + devices). ---
    const provision = runDriver('provision', { devices: DEVICE_PASSWORDS }, bundlePath)
    await new Promise((r) => setTimeout(r, 800))
    check('Wake Logger ensure_worker_role + provision_broker_device succeed', !provision.error && provision.worker_role === 'wakelogger-worker', provision.error || '')
    check('worker identity resolved (backward-compatible fallback)', !!provision.worker_username)

    // Read the persisted dynsec config to assert the role model.
    docker(['run', '--rm', '--user', 'root', '-v', `${directory}:/cfg`, MOSQUITTO_IMAGE, 'sh', '-c', 'chmod 0755 /cfg; chmod 0644 /cfg/dynamic-security.json'])
    const dynsec = JSON.parse(readFileSync(path.join(directory, 'dynamic-security.json'), 'utf8'))
    const roleNames = new Set(dynsec.roles.map((role) => role.rolename))
    const workerRole = dynsec.roles.find((role) => role.rolename === 'wakelogger-worker')
    const adminRole = dynsec.roles.find((role) => role.rolename === 'admin')
    check('worker role exists', roleNames.has('wakelogger-worker'))
    check('Device A and Device B roles exist', roleNames.has('wakelogger-device-device-a') && roleNames.has('wakelogger-device-device-b'))
    check('worker role has no $CONTROL access', !!workerRole && !workerRole.acls.some((acl) => acl.topic.includes('$CONTROL')))
    check('control admin role has no Wake Logger data ACLs', !!adminRole && !adminRole.acls.some((acl) => acl.topic.includes('wakelogger/v1/devices')))
    const workerClient = dynsec.clients.find((client) => client.username === provision.worker_username)
    check('worker client is assigned the worker role', !!workerClient && workerClient.roles.some((role) => role.rolename === 'wakelogger-worker'))
    const deviceAClient = dynsec.clients.find((client) => client.username === 'device-a')
    const deviceBClient = dynsec.clients.find((client) => client.username === 'device-b')
    check('Device A/B clients exist with their roles', !!deviceAClient?.encoded_password && !!deviceBClient?.encoded_password)
    process.stderr.write(`dynsec clients: ${dynsec.clients.map((client) => `${client.username}[${(client.roles || []).map((role) => role.rolename).join(',')}]`).join(' ')}\n`)

    // Cloud observer (provisioner identity also carries the worker role).
    const observer = await connect(url, ADMIN, ADMIN_PASSWORD, `worker-${process.pid}`)
    workerClients.push(observer)
    const observed = []
    // The worker role is scoped to the exact runtime topics (no broad #).
    await subscribe(observer, [
      'wakelogger/v1/devices/+/telemetry',
      'wakelogger/v1/devices/+/state',
      'wakelogger/v1/devices/+/status',
      'wakelogger/v1/devices/+/events',
      'wakelogger/v1/devices/+/profile-ack',
      'wakelogger/v1/devices/+/course-ack',
      'wakelogger/v1/devices/+/race-pack-ack'
    ])
    observer.on('message', (topic, payload) => observed.push({ topic, payload: payload.toString('utf8') }))

    const deviceTopics = (id) => `wakelogger/v1/devices/${id}`

    // --- Device isolation under dynsec roles. ---
    const spyA = await connect(url, 'device-a', DEVICE_PASSWORDS['device-a'], 'device-a')
    const spyB = await connect(url, 'device-b', DEVICE_PASSWORDS['device-b'], 'device-b')
    const spyMessages = []
    spyA.on('message', (topic) => spyMessages.push(topic))
    await subscribe(spyA, `${deviceTopics('device-b')}/#`).catch(() => undefined)
    // Device B publishes its own status (allowed); Device A must not receive it.
    await publish(spyB, `${deviceTopics('device-b')}/status`, JSON.stringify({ v: 1, state: 'online' }), { qos: 1 })
    await waitFor('worker sees device-b own status', () => Promise.resolve(observed.some((entry) => entry.topic.endsWith('device-b/status'))))
    await new Promise((r) => setTimeout(r, 300))
    check('Device A cannot subscribe/read Device B topics', spyMessages.length === 0)
    observed.length = 0
    await publish(spyA, `${deviceTopics('device-b')}/race-pack-ack`, JSON.stringify({ v: 1, packId: 'x', revision: 1, sha256: 'f'.repeat(64), status: 'applied' })).catch(() => undefined)
    await publish(spyA, `${deviceTopics('device-b')}/telemetry`, JSON.stringify({ v: 1, samples: [{ sequence: 1 }] })).catch(() => undefined)
    // Device B ACK routes to device-b/ack, which Device A cannot publish either.
    await publish(spyA, `${deviceTopics('device-b')}/ack`, JSON.stringify({ v: 1, deviceId: 'device-b', ackSequence: 1 })).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 400))
    check('Device A cannot publish Device B telemetry/status/ACK', !observed.some((entry) => entry.topic.startsWith(deviceTopics('device-b'))))
    // Device A can publish its own status.
    observed.length = 0
    await publish(spyA, `${deviceTopics('device-a')}/status`, JSON.stringify({ v: 1, state: 'online' }), { qos: 1 })
    await waitFor('device-a own status', () => Promise.resolve(observed.some((entry) => entry.topic.endsWith('device-a/status'))))
    check('Device A can publish its own status', true)
    await endClient(spyA)
    await endClient(spyB)

    // --- Actual Python Race Pack framing -> real plugin receiver -> ACK. ---
    const framing = runDriver('framing', { fixture_path: '/fixtures/race_pack_canonical.json' }, bundlePath, ['-v', `${API_DIRECTORY}/tests/fixtures/race_pack:/fixtures:ro`])
    check('actual Python build_transport + build_clear_manifest', !framing.error && framing.manifest?.chunkCount >= 1 && framing.clear?.action === 'clear', framing.error || '')

    const packDirectory = mkdtempSync(path.join(os.tmpdir(), 'dynsec-packs-a-'))
    outboxDirectories.push(packDirectory)
    const store = new RacePackStore(packDirectory)
    await store.open()
    const receiver = new RacePackReceiver({ store })
    const snapshotDirectory = mkdtempSync(path.join(os.tmpdir(), 'dynsec-snaps-a-'))
    outboxDirectories.push(snapshotDirectory)
    const snapshots = new OnboardSnapshotStore(path.join(snapshotDirectory, 'state.json'))
    await snapshots.open()
    const outboxDirectory = mkdtempSync(path.join(os.tmpdir(), 'dynsec-outbox-a-'))
    outboxDirectories.push(outboxDirectory)
    const outbox = new FileOutbox(outboxDirectory, { maxBytes: 1_000_000, maxAgeMs: 3_600_000, segmentBytes: 4096 })
    await outbox.open()
    const credentials = { version: 1, deviceId: 'device-a', clientId: 'device-a', username: 'device-a', password: DEVICE_PASSWORDS['device-a'], mqttHost: '127.0.0.1', mqttPort: port, tls: false, pairedAt: Date.now() }
    const makeTransport = () => new WakeLoggerTransport(credentials, outbox, {
      profile: DEFAULT_TELEMETRY_PROFILE, onState: () => undefined,
      onRacePackManifest: async (payload) => receiver.acceptManifest(payload),
      onRacePackChunk: async (payload, topicIndex) => receiver.acceptChunk(payload, topicIndex),
      getRacePackAck: () => receiver.currentAck(),
      onRacePlanSnapshotAcks: async (ids) => { await snapshots.acknowledge(ids) }
    })
    transport = makeTransport()
    transport.start()
    await waitFor('device-a online', () => Promise.resolve(observed.some((entry) => entry.topic.endsWith('device-a/status') && entry.payload.includes('online'))))
    observed.length = 0
    for (const chunk of [...framing.chunks].reverse()) await publish(observer, `${deviceTopics('device-a')}/race-pack/chunk/${chunk.index}`, JSON.stringify(chunk), { qos: 1, retain: true })
    await publish(observer, `${deviceTopics('device-a')}/race-pack/manifest`, JSON.stringify(framing.manifest), { qos: 1, retain: true })
    await waitFor('pack applied', () => Promise.resolve(store.applied()?.packId === framing.manifest.packId))
    check('real RacePackReceiver applies the Python-framed pack', store.applied()?.revision === framing.manifest.revision)
    await waitFor('pack ACK', () => Promise.resolve(observed.some((entry) => entry.topic.endsWith('device-a/race-pack-ack') && JSON.parse(entry.payload).status === 'applied')))
    check('plugin publishes applied Race Pack ACK under dynsec', true)

    // Real Wake Logger ACK ingestion -> onboard_ready.
    const appliedAck = JSON.parse(observed.find((entry) => entry.topic.endsWith('device-a/race-pack-ack') && JSON.parse(entry.payload).status === 'applied').payload)
    const ingest = runDriver('ingest-ack', { device_id: 'device-a', pack: framing.pack, manifest: framing.manifest, ack: appliedAck }, bundlePath)
    check('actual Wake Logger ingest_race_pack_ack reports onboard_ready', !ingest.error && ingest.status === 'onboard_ready', ingest.error || JSON.stringify(ingest))

    // --- Clear/tombstone. ---
    observed.length = 0
    await publish(observer, `${deviceTopics('device-a')}/race-pack/manifest`, JSON.stringify(framing.clear), { qos: 1, retain: true })
    await waitFor('cleared', () => Promise.resolve(store.clearedRevision() === framing.clear.revision))
    check('plugin clears durably from the Python clear manifest', store.applied() === null)
    await waitFor('clear ACK', () => Promise.resolve(observed.some((entry) => entry.topic.endsWith('device-a/race-pack-ack') && JSON.parse(entry.payload).action === 'clear')))
    const clearAck = JSON.parse(observed.find((entry) => entry.topic.endsWith('device-a/race-pack-ack') && JSON.parse(entry.payload).action === 'clear').payload)
    const clearIngest = runDriver('ingest-ack', { device_id: 'device-a', clear: true, pack: framing.pack, manifest: { ...framing.manifest, revision: framing.clear.revision }, ack: clearAck }, bundlePath)
    check('actual Wake Logger ingest reports no_plan after clear', !clearIngest.error && clearIngest.status === 'no_plan', clearIngest.error || JSON.stringify(clearIngest))
    // Stale pack cannot resurrect.
    for (const chunk of framing.chunks) await publish(observer, `${deviceTopics('device-a')}/race-pack/chunk/${chunk.index}`, JSON.stringify(chunk), { qos: 1, retain: true })
    await publish(observer, `${deviceTopics('device-a')}/race-pack/manifest`, JSON.stringify(framing.manifest), { qos: 1, retain: true })
    await new Promise((r) => setTimeout(r, 300))
    check('stale pack cannot resurrect after dynsec clear', store.applied() === null)

    // --- Local-only retained status + graceful disconnect. ---
    observed.length = 0
    await transport.publishFinalLocalOnlyStatus()
    await transport.stop({ publishOffline: false, force: false })
    await new Promise((r) => setTimeout(r, 2500))
    const localObserver = await connect(url, ADMIN, ADMIN_PASSWORD, `observer-${process.pid}-${Date.now()}`)
    const retainedLocalOnly = await readRetained(localObserver, `${deviceTopics('device-a')}/status`)
    await endClient(localObserver)
    let localBody = null
    try { localBody = retainedLocalOnly ? JSON.parse(retainedLocalOnly) : null } catch { localBody = null }
    check('fresh observer reads retained local_only under dynsec (no Will overwrite)', localBody?.uploadMode === 'local_only' && localBody?.state !== 'offline')
    check('no device traffic during local_only', observed.filter((entry) => /(telemetry|state|events|race-pack-ack)$/.test(entry.topic)).length === 0)

    // --- Automatic restore. ---
    observed.length = 0
    transport = makeTransport()
    transport.start()
    await waitFor('automatic reconnect online', () => Promise.resolve(observed.some((entry) => entry.topic.endsWith('device-a/status') && entry.payload.includes('online'))))
    const restoreObserver = await connect(url, ADMIN, ADMIN_PASSWORD, `observer-r-${process.pid}-${Date.now()}`)
    const retainedRestore = await readRetained(restoreObserver, `${deviceTopics('device-a')}/status`)
    await endClient(restoreObserver)
    let restoreBody = null
    try { restoreBody = retainedRestore ? JSON.parse(retainedRestore) : null } catch { restoreBody = null }
    check('automatic reconnect replaces retained local_only with online', restoreBody?.state === 'online')

    // --- Snapshot application ACK under dynsec. ---
    const snapshotId = `dynsec:${Date.now()}`
    const snapshot = buildSnapshot(snapshotId, 'session-dynsec')
    const sequence = await snapshots.append(snapshot, Date.now())
    await transport.publishRacePlanSnapshot(snapshot)
    await snapshots.markPublished([sequence])
    await waitFor('worker receives snapshot', () => Promise.resolve(observed.some((entry) => entry.topic.endsWith('device-a/events') && entry.payload.includes('race_plan_snapshot'))))
    check('worker role receives Device A snapshot under dynsec', true)
    await publish(observer, `${deviceTopics('device-a')}/ack`, JSON.stringify({ v: 1, deviceId: 'device-a', ackSequence: 0, racePlanSnapshotAcks: [{ id: snapshotId }] }), { qos: 1, retain: true })
    await waitFor('snapshot acknowledged', () => Promise.resolve(!snapshots.unacknowledged().some((event) => event.snapshot.id === snapshotId) && !snapshots.pending().some((event) => event.snapshot.id === snapshotId)))
    check('plugin marks the snapshot acknowledged from the worker ACK', true)
    // Device B cannot spoof an ACK for Device A's snapshot id.
    const spoofB = await connect(url, 'device-b', DEVICE_PASSWORDS['device-b'], 'device-b')
    const snapshotsBefore = snapshots.unacknowledged().length
    await publish(spoofB, `${deviceTopics('device-a')}/ack`, JSON.stringify({ v: 1, deviceId: 'device-a', ackSequence: 0, racePlanSnapshotAcks: [{ id: snapshotId }] })).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 300))
    check('Device B cannot publish an ACK for Device A', snapshots.unacknowledged().length === snapshotsBefore)
    await endClient(spoofB)

    // --- Telemetry drain/ACK. ---
    let queued
    for (let sequenceIndex = 1; sequenceIndex <= 3; sequenceIndex += 1) queued = await outbox.append('device-a', { capturedAt: sequenceIndex * 1000, receivedAt: sequenceIndex * 1000, values: { lat: -27.4, lon: 153.17, sog_kn: 6 }, quality: { timestamp: 'source' } })
    transport.updateCurrent(queued)
    await waitFor('telemetry published', () => Promise.resolve(observed.some((entry) => entry.topic.endsWith('device-a/telemetry'))))
    const telemetry = JSON.parse(observed.filter((entry) => entry.topic.endsWith('device-a/telemetry')).at(-1).payload)
    const through = telemetry.samples.at(-1).sequence
    await publish(observer, `${deviceTopics('device-a')}/ack`, JSON.stringify({ v: 1, deviceId: 'device-a', ackSequence: through }), { qos: 1, retain: true })
    await waitFor('telemetry drained', async () => (await outbox.stats()).acknowledgedSequence >= through)
    check('normal telemetry publishes, is received and ACKed under dynsec', true)

    // --- Disable / re-enable via actual Wake Logger helpers. ---
    await transport.stop({ publishOffline: false, force: true })
    const disabled = runDriver('disable', { device_id: 'device-a' }, bundlePath)
    check('actual disable_broker_device succeeds', !disabled.error, disabled.error || '')
    await new Promise((r) => setTimeout(r, 300))
    let denied = false
    try { const rejected = await connect(url, 'device-a', DEVICE_PASSWORDS['device-a'], 'device-a'); await endClient(rejected) } catch { denied = true }
    check('disabled Device A cannot reconnect', denied)
    const enabled = runDriver('enable', { device_id: 'device-a' }, bundlePath)
    check('actual enable_broker_device succeeds', !enabled.error, enabled.error || '')
    await new Promise((r) => setTimeout(r, 300))
    const reconnected = await connect(url, 'device-a', DEVICE_PASSWORDS['device-a'], 'device-a')
    check('re-enabled Device A can connect', !!reconnected)
    await endClient(reconnected)
  } catch (error) {
    failures += 1
    results.push(`FAIL  unexpected error — ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    try { await transport?.stop({ publishOffline: false, force: true }) } catch { /* ignore */ }
    for (const client of workerClients) { try { await endClient(client) } catch { /* ignore */ } }
    docker(['rm', '-f', container], { stdio: 'ignore' })
    for (const target of [directory, bundleDirectory, ...outboxDirectories]) { try { rmSync(target, { recursive: true, force: true }) } catch { /* ignore */ } }
  }
  process.stdout.write(`${results.join('\n')}\n`)
  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${results.filter((line) => line.startsWith('PASS')).length} passed, ${failures} failed\n`)
  process.exit(failures === 0 ? 0 : 1)
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

await main()
