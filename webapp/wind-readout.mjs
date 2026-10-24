// Shared live wind presentation. Angles are FROM the wind, relative to compass
// heading; the small arrow points downwind. TWD is a separate north bearing.
export const WIND_ARROW_PATH = 'M8 1.2 L13.4 10.2 H9.6 V14.8 H6.4 V10.2 H2.6 Z'
const finite = value => typeof value === 'number' && Number.isFinite(value)
const normalize = value => ((value % 360) + 360) % 360
export const signedWindAngle = value => finite(value) ? normalize(value + 180) - 180 : null
export function windAngleText(value) {
  const angle = signedWindAngle(value)
  if (angle === null) return '—'
  const side = angle === 0 || Math.abs(angle) === 180 ? '' : angle < 0 ? ' P' : ' S'
  return `${Math.round(Math.abs(angle))}°${side}`
}
export function windDirectionText(value) {
  return finite(value) ? `${String(Math.round(normalize(value)) % 360).padStart(3, '0')}°` : '—'
}
export function guidanceWind(snapshot, now = Date.now()) {
  if (snapshot?.v !== 1 || snapshot.algorithm !== 'sailing-guidance-v1') return null
  const fresh = (at, until) => finite(at) && finite(until) && now >= at - 1000 && now <= until
  const heading = fresh(snapshot.headingAt, snapshot.headingValidUntil) && finite(snapshot.headingDeg) ? snapshot.headingDeg : null
  const selected = typeof snapshot.sailingWindBasis === 'string'
  const at = selected ? snapshot.sailingWindAt : snapshot.windAt, until = selected ? snapshot.sailingWindValidUntil : snapshot.windValidUntil
  let from = selected ? snapshot.sailingWindFromDeg : snapshot.windFromDeg
  let speed = selected ? snapshot.sailingWindSpeedKn : snapshot.windSpeedKn
  let basis = selected ? snapshot.sailingWindBasis : 'ground'
  // Older snapshots used ground fields plus an optional current conversion.
  const current = fresh(snapshot.currentAt, snapshot.currentValidUntil) && finite(snapshot.currentEastKn) && finite(snapshot.currentNorthKn)
  const correction = finite(snapshot.correctionValidUntil) && now <= snapshot.correctionValidUntil && finite(snapshot.waterSpeedKn) && snapshot.waterSpeedKn >= 0.5
  const polar = finite(snapshot.targetTwaDeg) && finite(snapshot.targetSpeedKn) && snapshot.targetSpeedKn >= 0.5
  if (!selected && current && (correction || polar) && finite(snapshot.waterWindFromDeg) && finite(from) && finite(speed)) {
    speed = Math.hypot(speed * Math.sin(from * Math.PI / 180) + snapshot.currentEastKn, speed * Math.cos(from * Math.PI / 180) + snapshot.currentNorthKn)
    from = snapshot.waterWindFromDeg; basis = 'water'
  }
  const wind = fresh(at, until) && finite(from) && finite(speed)
  const age = snapshot.headingValidUntil - snapshot.headingAt
  const reading = name => {
    const value = snapshot.inputs?.[name]
    return value && finite(value.value) && fresh(value.at, value.at + age) ? value : null
  }
  const leeway = finite(snapshot.leewayAt) && fresh(snapshot.leewayAt, snapshot.leewayAt + age) && finite(snapshot.leewayDeg) ? snapshot.leewayDeg : 0
  const boatSpeed = reading(basis === 'water' ? 'stw' : 'sog')
  const course = basis === 'water' ? heading === null ? null : heading + leeway : reading('cog')?.value ?? null
  const clocks = [at, boatSpeed?.at, basis === 'water' ? snapshot.headingAt : reading('cog')?.at]
  const coherent = clocks.every(finite) && Math.max(...clocks) - Math.min(...clocks) <= 10000
  const velocity = boatSpeed && boatSpeed.value >= 0 ? boatSpeed.value / (basis === 'water' ? Math.cos(leeway * Math.PI / 180) : 1) : null
  const vmgKn = wind && coherent && velocity !== null && course !== null ? velocity * Math.cos((from - course) * Math.PI / 180) : null
  return { headingDeg: heading, twsKn: wind ? speed : null, twdDeg: wind ? from : null, basis, at, validUntil: until,
    vmgKn, vmgAt: coherent ? Math.min(...clocks) : null,
    twaDeg: wind && heading !== null ? signedWindAngle(from - heading) : null }
}
export function liveWindReadings(state, now = Date.now()) {
  const at = Date.parse(state?.capturedAt || '')
  const fresh = Number.isFinite(at) && now >= at - 1000 && now - at <= 120000
  const value = key => fresh && finite(state?.[key]) ? state[key] : null
  const published = guidanceWind(state?.guidance, now)
  const twd = published ? published.twdDeg : value('twdDeg')
  const heading = published ? published.headingDeg : value('headingDeg')
  const reference = published ? 'true' : state?.headingReference
  const trueHeading = reference === 'true' ? heading : null
  return { headingDeg: heading, headingReference: reference, awsKn: value('awsKn'), awaDeg: signedWindAngle(value('awaDeg')),
    twsKn: published ? published.twsKn : value('twsKn'), twdDeg: twd,
    windBasis: published?.basis ?? 'ground',
    twaDeg: published ? published.twaDeg : twd !== null && trueHeading !== null ? signedWindAngle(twd - trueHeading) : null }
}
