// Compass bearings are true; apparent wind angle is signed relative to the bow.
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
  const position = readings.find(reading => reading.id === 'position')
  const heading = readings.find(reading => reading.id === 'heading')
  const awa = readings.find(reading => reading.id === 'awa')
  const coordinate = position?.value
  const validPosition = coordinate && Number.isFinite(coordinate.latitude) && Math.abs(coordinate.latitude) <= 90
    && Number.isFinite(coordinate.longitude) && Math.abs(coordinate.longitude) <= 180
  const freshTogether = inputs => inputs.every(input => input?.freshness === 'fresh' && Number.isFinite(input.timestamp))
    && Math.max(...inputs.map(input => input.timestamp)) - Math.min(...inputs.map(input => input.timestamp)) <= 10000
  if (!validPosition || heading?.reference !== 'true' || !Number.isFinite(heading.value)
    || !freshTogether([position, heading])) return { position: null, heading: null, oppositeTack: null, apparentFrom: null }
  const result = { position: coordinate, heading: normalize(heading.value), oppositeTack: null, apparentFrom: null }
  if (!Number.isFinite(awa?.value) || !freshTogether([position, heading, awa])) return result
  const angle = signed(awa.value), absolute = Math.abs(angle)
  if (absolute < 20 || absolute >= 60) return result
  const apparentFrom = normalize(result.heading + angle)
  const legBearing = leg?.from && leg?.to ? bearingBetween(leg.from, leg.to) : null
  if (legBearing !== null && Math.abs(signed(apparentFrom - legBearing)) >= 60) return result
  return { ...result, apparentFrom, oppositeTack: normalize(apparentFrom + Math.sign(angle) * 30) }
}
