// Standalone vessel-instrument presentation. Reads only local Signal K
// measurements and presents them independently of any course, Race Pack,
// recording or Wake Logger connection state.
//
// Freshness is derived from each measurement's own RFC 3339 source timestamp,
// so it ages independently even while requests are stalled or failing. Missing
// or invalid timestamps are marked unknown rather than fresh, derived values
// require fresh, reference-compatible inputs bounded by their oldest input, and
// forecast data is never substituted for a live reading.
import { deriveTrueWindSample, normalizeDegrees } from './wind-derivation.mjs'

const MPS_TO_KNOTS = 1.9438444924406
const RADIANS_TO_DEGREES = 180 / Math.PI
export const INSTRUMENT_STALE_SECONDS = 30
export const MAX_INPUT_SKEW_SECONDS = 10
const FUTURE_SKEW_SECONDS = 5

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseSignalKTimestamp(raw) {
  if (finite(raw)) return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readEntry(root, path) {
  let node = root
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return null
    node = node[key]
  }
  if (node === null || node === undefined || typeof node !== 'object') return null
  if ('value' in node) return { value: node.value, timestamp: parseSignalKTimestamp(node.timestamp) }
  return { value: node, timestamp: null }
}

function reader(navigation, environment) {
  return (path) => {
    if (path.startsWith('navigation.')) return readEntry(navigation, path.slice('navigation.'.length))
    if (path.startsWith('environment.')) return readEntry(environment, path.slice('environment.'.length))
    return null
  }
}

function measured(entry, transform, now, staleSeconds) {
  const raw = entry && finite(entry.value) ? entry.value : null
  const value = raw === null ? null : transform(raw)
  const timestamp = entry ? entry.timestamp : null
  const known = finite(timestamp)
  const future = known && timestamp > now + FUTURE_SKEW_SECONDS * 1000
  const ageSeconds = known && !future ? Math.max(0, Math.round((now - timestamp) / 1000)) : null
  let freshness
  if (value === null || !finite(value)) freshness = 'missing'
  else if (!known || future) freshness = 'unknown'
  else freshness = ageSeconds > staleSeconds ? 'stale' : 'fresh'
  return { value: freshness === 'fresh' || freshness === 'stale' || freshness === 'unknown' ? value : null, timestamp: known && !future ? timestamp : null, ageSeconds, freshness, future: Boolean(future) }
}

function readingObject({ id, label, group, unit, decimals = 1, reference = null, source, value, timestamp, ageSeconds, freshness, basis = null }) {
  return {
    id, label, group, unit, decimals, reference, source, value, timestamp, ageSeconds, freshness,
    stale: freshness === 'stale', available: freshness === 'fresh' && finite(value), basis
  }
}

function direct({ id, label, group, entry, transform = (value) => value, unit, decimals = 1, reference = null, now, staleSeconds }) {
  const m = measured(entry, transform, now, staleSeconds)
  return readingObject({ id, label, group, unit, decimals, reference, source: 'direct', value: m.value, timestamp: m.timestamp, ageSeconds: m.ageSeconds, freshness: m.freshness })
}

export function positionReading(entry, now, staleSeconds) {
  const p = entry && entry.value && finite(entry.value.latitude) && finite(entry.value.longitude) ? entry.value : null
  const timestamp = entry ? entry.timestamp : null
  const known = finite(timestamp)
  const future = known && timestamp > now + FUTURE_SKEW_SECONDS * 1000
  const ageSeconds = known && !future ? Math.max(0, Math.round((now - timestamp) / 1000)) : null
  const freshness = p === null ? 'missing' : !known || future ? 'unknown' : ageSeconds > staleSeconds ? 'stale' : 'fresh'
  const base = readingObject({ id: 'position', label: 'Position', group: 'Vessel', unit: '°', decimals: 4, reference: 'GPS', source: 'direct', value: p, timestamp: known && !future ? timestamp : null, ageSeconds, freshness, basis: null })
  if (p) base.formatted = `${Math.abs(p.latitude).toFixed(4)}° ${p.latitude >= 0 ? 'N' : 'S'}, ${Math.abs(p.longitude).toFixed(4)}° ${p.longitude >= 0 ? 'E' : 'W'}`
  return base
}

function signedDegrees(value) {
  return ((value + 540) % 360) - 180
}

export function instrumentReadings({ navigation = {}, environment = {}, now = Date.now(), staleSeconds = INSTRUMENT_STALE_SECONDS, skewSeconds = MAX_INPUT_SKEW_SECONDS } = {}) {
  const entry = reader(navigation, environment)
  const readings = []

  readings.push(positionReading(entry('navigation.position'), now, staleSeconds))
  readings.push(direct({ id: 'sog', label: 'Speed over ground', group: 'Vessel', entry: entry('navigation.speedOverGround'), transform: (v) => v * MPS_TO_KNOTS, unit: 'kn', reference: 'SOG', now, staleSeconds }))
  readings.push(direct({ id: 'cog', label: 'Course over ground', group: 'Vessel', entry: entry('navigation.courseOverGroundTrue'), transform: (v) => normalizeDegrees(v * RADIANS_TO_DEGREES), unit: '° true', reference: 'true', decimals: 0, now, staleSeconds }))
  readings.push(direct({ id: 'stw', label: 'Speed through water', group: 'Vessel', entry: entry('navigation.speedThroughWater'), transform: (v) => v * MPS_TO_KNOTS, unit: 'kn', reference: 'STW', now, staleSeconds }))

  const headingTrue = entry('navigation.headingTrue')
  const headingMagnetic = entry('navigation.headingMagnetic')
  const headingSource = headingTrue ? { entry: headingTrue, reference: 'true' } : headingMagnetic ? { entry: headingMagnetic, reference: 'magnetic' } : null
  readings.push(direct({ id: 'heading', label: 'Heading', group: 'Vessel', entry: headingSource?.entry ?? null, transform: (v) => normalizeDegrees(v * RADIANS_TO_DEGREES), unit: headingSource ? `° ${headingSource.reference}` : '°', reference: headingSource?.reference ?? null, decimals: 0, now, staleSeconds }))

  const depthCandidates = [['belowTransducer', 'below transducer'], ['belowKeel', 'below keel'], ['belowSurface', 'below surface']]
  let depth = null
  for (const [key, reference] of depthCandidates) {
    const candidate = entry(`environment.depth.${key}`)
    if (candidate && finite(candidate.value)) { depth = { entry: candidate, reference }; break }
  }
  readings.push(direct({ id: 'depth', label: 'Depth', group: 'Depth', entry: depth?.entry ?? null, unit: 'm', reference: depth?.reference ?? null, now, staleSeconds }))

  readings.push(direct({ id: 'aws', label: 'Apparent wind speed', group: 'Wind', entry: entry('environment.wind.speedApparent'), transform: (v) => v * MPS_TO_KNOTS, unit: 'kn', reference: 'apparent', now, staleSeconds }))
  readings.push(direct({ id: 'awa', label: 'Apparent wind angle', group: 'Wind', entry: entry('environment.wind.angleApparent'), transform: (v) => signedDegrees(v * RADIANS_TO_DEGREES), unit: '° apparent', reference: 'apparent', decimals: 0, now, staleSeconds }))
  readings.push(direct({ id: 'twa-ground', label: 'True wind angle (ground)', group: 'Wind', entry: entry('environment.wind.angleTrueGround'), transform: (v) => signedDegrees(v * RADIANS_TO_DEGREES), unit: '° true', reference: 'ground', decimals: 0, now, staleSeconds }))
  readings.push(direct({ id: 'twa-water', label: 'True wind angle (water)', group: 'Wind', entry: entry('environment.wind.angleTrueWater'), transform: (v) => signedDegrees(v * RADIANS_TO_DEGREES), unit: '° true', reference: 'water', decimals: 0, now, staleSeconds }))
  const trueWindSpeed = direct({ id: 'tws', label: 'True wind speed', group: 'Wind', entry: entry('environment.wind.speedTrue'), transform: (v) => v * MPS_TO_KNOTS, unit: 'kn', reference: 'true', now, staleSeconds })
  const trueWindDirection = direct({ id: 'twd', label: 'True wind direction', group: 'Wind', entry: entry('environment.wind.directionTrue'), transform: (v) => normalizeDegrees(v * RADIANS_TO_DEGREES), unit: '° true', reference: 'true', decimals: 0, now, staleSeconds })
  const aws = readings.find((r) => r.id === 'aws')
  const awa = readings.find((r) => r.id === 'awa')
  const sog = readings.find((r) => r.id === 'sog')
  const cog = readings.find((r) => r.id === 'cog')
  const stw = readings.find((r) => r.id === 'stw')
  const heading = readings.find((r) => r.id === 'heading')
  const trueHeading = heading?.reference === 'true' ? heading : null

  // A derived wind is only produced from reference-compatible, fresh inputs.
  // The apparent angle is relative to the vessel heading, so a true heading (or
  // an absolute true apparent direction) is required; a magnetic-only heading is
  // never treated as true.
  const apparentDirection = direct({ id: 'awd', label: 'Apparent wind direction', group: 'Wind', entry: entry('environment.wind.directionApparent'), transform: (v) => normalizeDegrees(v * RADIANS_TO_DEGREES), unit: '° true', reference: 'true', decimals: 0, now, staleSeconds })
  const canDerive = trueWindSpeed?.available !== true || trueWindDirection?.available !== true
  let windSpeed = trueWindSpeed
  let windDirection = trueWindDirection
  if (canDerive) {
    const boatReference = cog?.available && sog?.available
      ? { cogDeg: cog.value, sogKnots: sog.value, basis: 'ground' }
      : trueHeading?.available && stw?.available
        ? { headingDeg: trueHeading.value, stwKnots: stw.value, basis: 'water' }
        : null
    const apparentReference = apparentDirection.available
      ? { apparentDirectionDeg: apparentDirection.value, ts: apparentDirection.timestamp, reading: apparentDirection }
      : trueHeading?.available && awa?.available
        ? { awaDeg: awa.value, headingDeg: trueHeading.value, ts: awa.timestamp, reading: awa }
        : null
    if (boatReference && apparentReference && aws?.available) {
      const sample = deriveTrueWindSample({
        awsKnots: aws.value,
        ...boatReference,
        ...apparentReference
      })
      const boatTimestamp = boatReference.basis === 'ground' ? cog.timestamp : trueHeading.timestamp
      const inputTimestamps = [aws.timestamp, boatTimestamp, apparentReference.ts].filter(finite)
      const skewOk = inputTimestamps.length === 3 && (Math.max(...inputTimestamps) - Math.min(...inputTimestamps)) <= skewSeconds * 1000
      const bound = inputTimestamps.length ? Math.min(...inputTimestamps) : null
      const age = bound === null ? null : Math.floor((now - bound) / 1000)
      const staleBound = !skewOk || [aws, boatReference.basis === 'ground' ? cog : trueHeading, apparentReference.reading].filter(Boolean).some((r) => r.freshness !== 'fresh') || age === null || age > staleSeconds
      if (sample && !staleBound) {
        windSpeed = readingObject({ id: 'tws', label: 'True wind speed', group: 'Wind', unit: 'kn', reference: sample.direct ? 'true' : 'derived', source: 'derived', value: sample.twsKnots, timestamp: bound, ageSeconds: age, freshness: 'fresh', basis: boatReference.basis })
        windDirection = readingObject({ id: 'twd', label: 'True wind direction', group: 'Wind', unit: '° true', decimals: 0, reference: 'true', source: 'derived', value: sample.twdDeg, timestamp: bound, ageSeconds: age, freshness: 'fresh', basis: boatReference.basis })
      }
    }
  }
  readings.push(windSpeed)
  readings.push(windDirection)

  // Wind-relative VMG uses a consistent velocity vector: ground-relative from
  // SOG/COG, water-relative from STW/true heading. Each is labelled.
  const twd = windDirection?.available ? windDirection.value : null
  if (finite(twd) && cog?.available && sog?.available) {
    const value = sog.value * Math.cos(signedDegrees(twd - cog.value) * Math.PI / 180)
    const timestamp = Math.min(...[sog.timestamp, cog.timestamp, windDirection.timestamp].filter(finite))
    readings.push(readingObject({ id: 'vmg-wind-ground', label: 'VMG to wind (ground)', group: 'Wind', unit: 'kn', reference: 'wind · ground', source: 'derived', value, timestamp, ageSeconds: Math.floor((now - timestamp) / 1000), freshness: 'fresh', basis: 'ground' }))
  }
  if (finite(twd) && trueHeading?.available && stw?.available) {
    const value = stw.value * Math.cos(signedDegrees(twd - trueHeading.value) * Math.PI / 180)
    const timestamp = Math.min(...[trueHeading.timestamp, stw.timestamp, windDirection.timestamp].filter(finite))
    readings.push(readingObject({ id: 'vmg-wind-water', label: 'VMG to wind (water)', group: 'Wind', unit: 'kn', reference: 'wind · water', source: 'derived', value, timestamp, ageSeconds: Math.floor((now - timestamp) / 1000), freshness: 'fresh', basis: 'water' }))
  }

  const available = readings.filter((item) => item.available).length
  return { readings, available, total: readings.length, evaluatedAt: now, staleSeconds }
}

export function formatReading(reading) {
  if (!reading) return '—'
  if (reading.id === 'position') return reading.value ? reading.formatted : 'Unavailable'
  if (!finite(reading.value)) {
    if (reading.freshness === 'stale') return 'Stale'
    if (reading.freshness === 'unknown') return 'Timestamp unknown'
    return 'Unavailable'
  }
  const decimals = Number.isInteger(reading.decimals) ? reading.decimals : 1
  return `${reading.value.toFixed(decimals)}${reading.unit ? ` ${reading.unit}` : ''}`
}
