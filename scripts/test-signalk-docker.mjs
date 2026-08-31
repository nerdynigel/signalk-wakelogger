import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const composeFile = fileURLToPath(new URL('../test/docker/compose.yml', import.meta.url))
const project = (process.env.WAKELOGGER_DOCKER_PROJECT || `signalk-wakelogger-e2e-${process.pid}`).toLowerCase().replace(/[^a-z0-9_-]/g, '-')
const keep = process.env.WAKELOGGER_DOCKER_KEEP === '1'
let stackStarted = false

function docker(arguments_, options = {}) {
  const result = spawnSync('docker', arguments_, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: process.env
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`docker ${arguments_.join(' ')} failed with exit code ${result.status}${detail ? `\n${detail}` : ''}`)
  }
  return result
}

function compose(arguments_, options = {}) {
  return docker(['compose', '--project-name', project, '--file', composeFile, ...arguments_], options)
}

function query(target, method = 'GET', body) {
  const arguments_ = ['exec', '-T', 'test-cloud', 'node', '/app/query.mjs', target, method]
  if (body !== undefined) arguments_.push(JSON.stringify(body))
  const result = compose(arguments_, { capture: true })
  return JSON.parse(result.stdout)
}

function snapshot() {
  return query('https://test-cloud:8443/snapshot')
}

async function waitFor(description, predicate, timeoutMs = 90_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function dataEvents(value) {
  return value.events.filter((event) => event.topic === 'wakelogger/v1/devices/dev_docker_e2e/state' || event.topic === 'wakelogger/v1/devices/dev_docker_e2e/telemetry')
}

function telemetrySamples(value) {
  return value.events
    .filter((event) => event.topic === 'wakelogger/v1/devices/dev_docker_e2e/telemetry')
    .flatMap((event) => Array.isArray(event.payload?.samples) ? event.payload.samples : [])
}

function maximumAck(value) {
  return Number(value.maximumAcknowledged?.dev_docker_e2e ?? 0)
}

function printServiceStats() {
  const ids = ['signalk', 'mosquitto', 'test-cloud']
    .map((service) => compose(['ps', '--quiet', service], { capture: true }).stdout.trim())
    .filter(Boolean)
  if (!ids.length) return []
  const result = docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids], { capture: true })
  return result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function diagnostics() {
  if (!stackStarted) return
  process.stderr.write('\nDocker end-to-end diagnostics:\n')
  compose(['ps'], { allowFailure: true })
  compose(['logs', '--no-color', '--tail', '300'], { allowFailure: true })
}

function cleanup() {
  if (!stackStarted || keep) return
  compose(['down', '--volumes', '--remove-orphans'], { allowFailure: true })
  stackStarted = false
}

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    cleanup()
    process.exit(exitCode)
  })
}

try {
  docker(['compose', 'version'])
  stackStarted = true
  compose(['up', '--detach', '--build'])

  await waitFor('mock cloud MQTT subscription', () => query('https://test-cloud:8443/health').ok)
  await waitFor('Signal K server and sample position', () => {
    const position = query('http://signalk:3000/signalk/v1/api/vessels/self/navigation/position')
    return Number.isFinite(position?.value?.latitude) && Number.isFinite(position?.value?.longitude)
  }, 120_000)

  const initial = await waitFor('three durably acknowledged telemetry samples', () => {
    const value = snapshot()
    return maximumAck(value) >= 3 ? value : undefined
  }, 120_000)
  assert.equal(initial.pairingCount, 1, 'the real plugin must complete exactly one pairing exchange')
  const initialSamples = telemetrySamples(initial)
  const expectedNumericFields = ['lat', 'lon', 'sog_kn', 'cog_deg', 'heading_deg', 'depth_m', 'aws_kn', 'awa_deg']
  for (const field of expectedNumericFields) {
    assert.ok(initialSamples.some((sample) => Number.isFinite(sample?.values?.[field])), `sample NMEA 2000 telemetry must contain ${field}`)
  }
  assert.ok(initialSamples.some((sample) => sample?.values?.heading_reference === 'true'), 'sample NMEA 2000 heading must retain its true reference')
  assert.equal(dataEvents(initial)[0]?.topic, 'wakelogger/v1/devices/dev_docker_e2e/state', 'current state must precede backlog telemetry')

  compose(['stop', 'mosquitto'])
  await delay(1_000)
  const baselineAck = maximumAck(snapshot())
  await delay(7_000)
  compose(['kill', '--signal', 'SIGKILL', 'signalk'])

  compose(['start', 'mosquitto'])
  await waitFor('mock cloud reconnection', () => query('https://test-cloud:8443/health').ok)
  query('https://test-cloud:8443/events/reset', 'POST', {})
  compose(['start', 'signalk'])

  await waitFor('Signal K restart', () => {
    const position = query('http://signalk:3000/signalk/v1/api/vessels/self/navigation/position')
    return Number.isFinite(position?.value?.latitude) && Number.isFinite(position?.value?.longitude)
  }, 120_000)
  const recovered = await waitFor('post-crash backlog acknowledgement', () => {
    const value = snapshot()
    return maximumAck(value) >= baselineAck + 2 ? value : undefined
  }, 120_000)
  const recoveredSamples = telemetrySamples(recovered).filter((sample) => sample.sequence > baselineAck)
  assert.ok(recoveredSamples.length >= 2, 'at least two outage samples must survive the abrupt Signal K stop')
  assert.equal(dataEvents(recovered)[0]?.topic, 'wakelogger/v1/devices/dev_docker_e2e/state', 'current state must be first after reconnect')
  assert.ok(recoveredSamples.every((sample) => sample.deviceId === 'dev_docker_e2e'), 'recovered samples must retain their paired device identity')

  const drained = await waitFor('reported empty queue after application ACK', () => {
    const value = snapshot()
    const statuses = value.events.filter((event) => event.topic === 'wakelogger/v1/devices/dev_docker_e2e/status')
    return statuses.some((event) => event.payload?.queueMessageCount === 0 && event.payload?.acknowledgedSequence >= maximumAck(recovered)) ? value : undefined
  }, 35_000)

  const result = {
    ok: true,
    signalkSource: 'sample-n2k-data',
    tlsPairing: true,
    tlsMqtt: true,
    initialAcknowledgedSequence: maximumAck(initial),
    outageBaselineSequence: baselineAck,
    recoveredAcknowledgedSequence: maximumAck(recovered),
    recoveredSampleCount: recoveredSamples.length,
    persistedCloudEventCount: drained.persistedCount,
    observedTelemetryFields: [...expectedNumericFields, 'heading_reference'],
    currentStatePrecededBacklog: true,
    queueDrainedAfterAck: true,
    serviceStats: printServiceStats()
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  diagnostics()
  throw error
} finally {
  cleanup()
}
