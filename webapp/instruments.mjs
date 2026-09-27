// Standalone vessel-instrument presentation. Reads only local Signal K
// measurements and presents them independently of any course, Race Pack,
// recording or Wake Logger connection state. Each reading tracks its own source
// timestamp so one stale sensor never masks another, and missing values are
// shown as unavailable rather than invented. Forecast values are never
// substituted for live instrument readings.
const MPS_TO_KNOTS = 1.9438444924406
const RADIANS_TO_DEGREES = 180 / Math.PI
const DEFAULT_STALE_SECONDS = 30

export const INSTRUMENT_STALE_SECONDS = DEFAULT_STALE_SECONDS

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function readValue(root, path) {
  let node = root
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return null
    node = node[key]
  }
  if (node === null || node === undefined || typeof node !== 'object') return null
  if ('value' in node) return { value: node.value, timestamp: Number.isFinite(node.timestamp) ? node.timestamp : null }
  return { value: node, timestamp: null }
}

function reading({ id, label, group, value, unit, reference = null, source = 'direct', timestamp = null, now, staleSeconds = DEFAULT_STALE_SECONDS, decimals = 1 }) {
  const numeric = finite(value)
  const ageSeconds = timestamp === null ? null : Math.max(0, Math.round((now - timestamp) / 1000))
  const stale = ageSeconds !== null && ageSeconds > staleSeconds
  return {
    id, label, group, unit,
    value: numeric ? value : null,
    reference,
    source,
    timestamp,
    ageSeconds,
    stale,
    available: numeric && !stale,
    decimals
  }
}

function angleDegrees(entry, { signed = false } = {}) {
  if (!entry || !finite(entry.value)) return null
  const degrees = signed ? ((entry.value * RADIANS_TO_DEGREES + 540) % 360) - 180 : normalizeDegrees(entry.value * RADIANS_TO_DEGREES)
  return { value: degrees, timestamp: entry.timestamp }
}

function speedKnots(entry) {
  if (!entry || !finite(entry.value)) return null
  return { value: entry.value * MPS_TO_KNOTS, timestamp: entry.timestamp }
}

// Mirrors the shared apparent-to-true derivation used by the onboard planner:
// prefer the ground vector (COG + SOG), fall back to the water vector
// (heading + STW). Never fabricates wind.
export function deriveTrueWind(input) {
  if (!finite(input.awsKnots) || input.awsKnots <= 0) return null
  const heading = finite(input.headingDeg) ? input.headingDeg : null
  const cog = finite(input.cogDeg) ? input.cogDeg : null
  if (heading === null && cog === null) return null
  let boatReference
  let boatSpeed
  if (finite(input.sogKnots)) { boatReference = cog ?? heading; boatSpeed = input.sogKnots }
  else if (finite(input.stwKnots)) { boatReference = heading ?? cog; boatSpeed = input.stwKnots }
  else return null
  let apparentFromDeg = null
  if (finite(input.apparentDirectionDeg)) apparentFromDeg = normalizeDegrees(input.apparentDirectionDeg)
  else if (finite(input.awaDeg)) apparentFromDeg = normalizeDegrees((heading ?? cog ?? 0) + input.awaDeg)
  if (apparentFromDeg === null) return null
  const apparentTo = normalizeDegrees(apparentFromDeg + 180)
  const apparentRadians = apparentTo * Math.PI / 180
  const boatRadians = normalizeDegrees(boatReference) * Math.PI / 180
  const x = Math.sin(apparentRadians) * input.awsKnots + Math.sin(boatRadians) * boatSpeed
  const y = Math.cos(apparentRadians) * input.awsKnots + Math.cos(boatRadians) * boatSpeed
  const speed = Math.hypot(x, y)
  if (!Number.isFinite(speed) || speed <= 0.05) return null
  return { twsKnots: speed, twdDeg: normalizeDegrees(normalizeDegrees(Math.atan2(x, y) * 180 / Math.PI) + 180), reference: 'derived' }
}

export function positionReading(entry, now, staleSeconds) {
  if (!entry || !entry.value || !finite(entry.value.latitude) || !finite(entry.value.longitude)) {
    return reading({ id: 'position', label: 'Position', group: 'Vessel', value: null, unit: '°', timestamp: entry?.timestamp ?? null, now, staleSeconds, decimals: 4 })
  }
  const { latitude, longitude } = entry.value
  const ageSeconds = entry.timestamp === null ? null : Math.max(0, Math.round((now - entry.timestamp) / 1000))
  return {
    id: 'position', label: 'Position', group: 'Vessel', unit: '°', decimals: 4,
    value: { latitude, longitude }, reference: 'GPS', source: 'direct', timestamp: entry.timestamp,
    ageSeconds, stale: ageSeconds !== null && ageSeconds > staleSeconds,
    available: ageSeconds === null || ageSeconds <= staleSeconds,
    formatted: `${Math.abs(latitude).toFixed(4)}° ${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}° ${longitude >= 0 ? 'E' : 'W'}`
  }
}

export function instrumentReadings({ navigation = {}, environment = {}, now = Date.now(), staleSeconds = DEFAULT_STALE_SECONDS } = {}) {
  const nav = (path) => readValue(navigation, path)
  const env = (path) => readValue(environment, path)
  const readings = []

  readings.push(positionReading(nav('position'), now, staleSeconds))
  readings.push(reading({ id: 'sog', label: 'Speed over ground', group: 'Vessel', value: speedKnots(nav('speedOverGround'))?.value, unit: 'kn', reference: 'SOG', source: 'direct', timestamp: nav('speedOverGround')?.timestamp, now, staleSeconds }))
  readings.push(reading({ id: 'cog', label: 'Course over ground', group: 'Vessel', value: angleDegrees(nav('courseOverGroundTrue'))?.value, unit: '° true', reference: 'true', source: 'direct', timestamp: nav('courseOverGroundTrue')?.timestamp, now, staleSeconds, decimals: 0 }))

  const headingTrue = nav('headingTrue')
  const headingMagnetic = nav('headingMagnetic')
  const heading = angleDegrees(headingTrue) ? { ...angleDegrees(headingTrue), reference: 'true' } : angleDegrees(headingMagnetic) ? { ...angleDegrees(headingMagnetic), reference: 'magnetic' } : null
  readings.push(reading({ id: 'heading', label: 'Heading', group: 'Vessel', value: heading?.value, unit: `° ${heading?.reference ?? ''}`.trim(), reference: heading?.reference ?? null, source: 'direct', timestamp: heading?.timestamp ?? null, now, staleSeconds, decimals: 0 }))
  readings.push(reading({ id: 'stw', label: 'Speed through water', group: 'Vessel', value: speedKnots(nav('speedThroughWater'))?.value, unit: 'kn', reference: 'STW', source: 'direct', timestamp: nav('speedThroughWater')?.timestamp, now, staleSeconds }))

  const depthCandidates = [
    ['belowTransducer', 'below transducer'],
    ['belowKeel', 'below keel'],
    ['belowSurface', 'below surface']
  ]
  let depth = null
  for (const [key, reference] of depthCandidates) {
    const entry = env(`depth.${key}`)
    if (entry && finite(entry.value)) { depth = { value: entry.value, reference, timestamp: entry.timestamp }; break }
  }
  readings.push(reading({ id: 'depth', label: 'Depth', group: 'Depth', value: depth?.value, unit: 'm', reference: depth?.reference ?? null, source: 'direct', timestamp: depth?.timestamp ?? null, now, staleSeconds }))

  const awsEntry = speedKnots(env('wind.speedApparent'))
  readings.push(reading({ id: 'aws', label: 'Apparent wind speed', group: 'Wind', value: awsEntry?.value, unit: 'kn', reference: 'apparent', source: 'direct', timestamp: env('wind.speedApparent')?.timestamp, now, staleSeconds }))
  const awaEntry = env('wind.angleApparent')
  readings.push(reading({ id: 'awa', label: 'Apparent wind angle', group: 'Wind', value: angleDegrees(awaEntry, { signed: true })?.value, unit: '°', reference: 'apparent', source: 'direct', timestamp: awaEntry?.timestamp, now, staleSeconds, decimals: 0 }))

  const directTws = speedKnots(env('wind.speedTrue'))
  const directTwd = angleDegrees(env('wind.directionTrue'))
  const headingValue = heading ? heading.value : null
  const cogValue = angleDegrees(nav('courseOverGroundTrue'))?.value ?? null
  const sogKnots = speedKnots(nav('speedOverGround'))?.value ?? null
  const stwKnots = speedKnots(nav('speedThroughWater'))?.value ?? null
  const derived = (!directTws || !directTwd)
    ? deriveTrueWind({
        awsKnots: awsEntry?.value ?? null,
        awaDeg: angleDegrees(awaEntry, { signed: true })?.value ?? null,
        apparentDirectionDeg: angleDegrees(env('wind.directionApparent'))?.value ?? null,
        headingDeg: headingValue,
        cogDeg: cogValue,
        sogKnots,
        stwKnots
      })
    : null
  readings.push(reading({ id: 'tws', label: 'True wind speed', group: 'Wind', value: directTws?.value ?? derived?.twsKnots ?? null, unit: 'kn', reference: directTws ? 'true' : derived ? 'derived' : 'true', source: directTws ? 'direct' : derived ? 'derived' : 'direct', timestamp: directTws?.timestamp ?? (derived ? Math.max(env('wind.speedApparent')?.timestamp ?? 0, nav('speedOverGround')?.timestamp ?? 0) || null : null), now, staleSeconds }))
  readings.push(reading({ id: 'twd', label: 'True wind direction', group: 'Wind', value: directTwd?.value ?? derived?.twdDeg ?? null, unit: '° true', reference: 'true', source: directTwd ? 'direct' : derived ? 'derived' : 'direct', timestamp: directTwd?.timestamp ?? (derived ? env('wind.speedApparent')?.timestamp ?? null : null), now, staleSeconds, decimals: 0 }))

  // VMG here is relative to the wind, never towards a waypoint, and says so.
  const twd = directTwd?.value ?? derived?.twdDeg ?? null
  let vmgWind = null
  if (finite(sogKnots) && finite(twd)) {
    const reference = finite(headingValue) ? headingValue : cogValue
    if (finite(reference)) vmgWind = sogKnots * Math.cos(((twd - reference) * Math.PI) / 180)
  }
  readings.push(reading({ id: 'vmg-wind', label: 'VMG relative to wind', group: 'Wind', value: vmgWind, unit: 'kn', reference: 'wind', source: 'derived', timestamp: env('wind.speedApparent')?.timestamp ?? nav('speedOverGround')?.timestamp ?? null, now, staleSeconds }))

  const available = readings.filter((item) => item.available).length
  return { readings, available, total: readings.length, evaluatedAt: now, staleSeconds }
}

export function formatReading(reading) {
  if (!reading) return '—'
  if (reading.id === 'position') return reading.value ? reading.formatted : 'Unavailable'
  if (reading.value === null || reading.value === undefined) return 'Unavailable'
  const decimals = Number.isInteger(reading.decimals) ? reading.decimals : 1
  return `${reading.value.toFixed(decimals)}${reading.unit ? ` ${reading.unit}` : ''}`
}
