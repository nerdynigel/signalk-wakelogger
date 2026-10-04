// Mirrored maneuver estimates use ground-relative true wind derived from fresh
// apparent wind and boat motion. They are not tide/leeway-corrected laylines.
import { deriveTrueWindSample } from './wind-derivation.mjs'
const radians = value => value * Math.PI / 180
const degrees = value => value * 180 / Math.PI
const normalize = value => ((value % 360) + 360) % 360
const signed = value => ((value + 540) % 360) - 180
const EARTH_RADIUS_M = 6371000

export function projectBearing(position, bearing, distanceM) {
  const latitude = radians(position.latitude), longitude = radians(position.longitude)
  const angle = distanceM / EARTH_RADIUS_M, direction = radians(bearing)
  const endLatitude = Math.asin(Math.sin(latitude) * Math.cos(angle) + Math.cos(latitude) * Math.sin(angle) * Math.cos(direction))
  const endLongitude = longitude + Math.atan2(Math.sin(direction) * Math.sin(angle) * Math.cos(latitude), Math.cos(angle) - Math.sin(latitude) * Math.sin(endLatitude))
  return { latitude: degrees(endLatitude), longitude: signed(degrees(endLongitude)) }
}

export function bearingBetween(from, to) {
  const lat1 = radians(from.latitude), lat2 = radians(to.latitude), delta = radians(to.longitude - from.longitude)
  const x = Math.sin(delta) * Math.cos(lat2)
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(delta)
  return Math.abs(x) + Math.abs(y) < 1e-12 ? null : normalize(degrees(Math.atan2(x, y)))
}

export function vesselGuideBearings(readings, leg = null) {
  const byId = id => readings.find(reading => reading.id === id)
  const position = byId('position'), heading = byId('heading'), awa = byId('awa')
  const aws = byId('aws'), sog = byId('sog'), cog = byId('cog')
  const coordinate = position?.value
  const validPosition = coordinate && Number.isFinite(coordinate.latitude) && Math.abs(coordinate.latitude) <= 90
    && Number.isFinite(coordinate.longitude) && Math.abs(coordinate.longitude) <= 180
  const freshTogether = inputs => inputs.every(input => input?.freshness === 'fresh' && Number.isFinite(input.timestamp))
    && Math.max(...inputs.map(input => input.timestamp)) - Math.min(...inputs.map(input => input.timestamp)) <= 10000
  const empty = { position: null, heading: null, maneuverBearing: null, kind: null, trueWindFrom: null, trueWindSpeed: null }
  if (!validPosition || heading?.reference !== 'true' || !Number.isFinite(heading.value)
    || !freshTogether([position, heading])) return empty
  const result = { ...empty, position: coordinate, heading: normalize(heading.value) }
  if (![awa, aws, sog, cog].every(input => Number.isFinite(input?.value))
    || cog.reference !== 'true' || !freshTogether([position, heading, awa, aws, sog, cog])) return result
  const wind = deriveTrueWindSample({ awsKnots: aws.value, awaDeg: awa.value, headingDeg: heading.value, sogKnots: sog.value, cogDeg: cog.value })
  if (!wind) return result
  const twa = Math.abs(signed(wind.twdDeg - result.heading)), apparentAngle = Math.abs(signed(awa.value))
  const kind = twa > 0 && twa < 90 && apparentAngle >= 20 && apparentAngle < 60 ? 'tack'
    : twa > 100 && twa < 175 ? 'gybe' : null
  if (!kind) return result
  const legBearing = leg?.from && leg?.to ? bearingBetween(leg.from, leg.to) : null
  const legAngle = legBearing === null ? null : Math.abs(signed(wind.twdDeg - legBearing))
  if (legAngle !== null && (kind === 'tack' ? legAngle >= 90 : legAngle <= 90)) return result
  return { ...result, kind, trueWindFrom: wind.twdDeg, trueWindSpeed: wind.twsKnots, maneuverBearing: normalize(2 * wind.twdDeg - result.heading) }
}
