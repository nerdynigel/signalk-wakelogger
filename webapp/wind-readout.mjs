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
  const wind = fresh(snapshot.windAt, snapshot.windValidUntil) && finite(snapshot.windFromDeg) && finite(snapshot.windSpeedKn)
  return { headingDeg: heading, twsKn: wind ? snapshot.windSpeedKn : null, twdDeg: wind ? snapshot.windFromDeg : null,
    twaDeg: wind && heading !== null ? signedWindAngle(snapshot.windFromDeg - heading) : null }
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
    twaDeg: published ? published.twaDeg : twd !== null && trueHeading !== null ? signedWindAngle(twd - trueHeading) : null }
}
