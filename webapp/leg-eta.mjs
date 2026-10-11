// Net signed progress on a fixed great-circle leg axis, never track mileage.
// Kept independent of DOM/Signal K so other surfaces can adopt the definition
// once they have real activation and individual sensor provenance.
export const MIN_LEG_WINDOW_MS = 60_000
export const MAX_ETA_SECONDS = 86_400
const R = 6371000
const rad = d => d * Math.PI / 180
const valid = p => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180
function polar(from, to) {
  const a = rad(from.latitude), b = rad(to.latitude), d = rad(to.longitude - from.longitude)
  const h = Math.sin((b-a)/2)**2 + Math.cos(a)*Math.cos(b)*Math.sin(d/2)**2
  return { angle: 2*Math.atan2(Math.sqrt(Math.min(1,h)), Math.sqrt(Math.max(0,1-h))), bearing: Math.atan2(Math.sin(d)*Math.cos(b), Math.cos(a)*Math.sin(b)-Math.sin(a)*Math.cos(b)*Math.cos(d)) }
}
export function alongLegMeters(origin, target, position) {
  if (![origin,target,position].every(valid)) return null
  const axis = polar(origin,target), p = polar(origin,position)
  if (!(axis.angle > 0) || axis.angle >= Math.PI/2) return null
  return R*Math.atan2(Math.sin(p.angle)*Math.cos(p.bearing-axis.bearing), Math.cos(p.angle))
}
export function legAverageEta({ marker, origin, target, position, positionTime, distanceNm, now, fallbackKn = null }) {
  const unavailable = reason => ({ vmgKn: null, timeToGo: null, eta: null, etaReason: reason, etaProvisional: false })
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) || !Number.isFinite(distanceNm) || distanceNm < 0) return unavailable('Navigation inputs unavailable')
  if (!marker || !Number.isFinite(marker.startedAt) || marker.startedAt < marker.observedAt || marker.startedAt > now) return unavailable('Leg start unavailable')
  if (!Number.isFinite(positionTime) || positionTime < marker.startedAt) return unavailable('Leg samples unavailable')
  const elapsed = now-marker.startedAt
  const provisional = elapsed < MIN_LEG_WINDOW_MS
  let speed = fallbackKn
  if (!provisional) {
    if (!valid(marker.position) || !Number.isFinite(marker.positionTimestamp) || marker.positionTimestamp > marker.startedAt || marker.startedAt-marker.positionTimestamp > 30000) return unavailable('Leg start position unavailable')
    if (positionTime <= marker.startedAt) return unavailable('Leg samples unavailable')
    const axisOrigin = origin || marker.position
    const initial = alongLegMeters(axisOrigin,target,marker.position), current = alongLegMeters(axisOrigin,target,position)
    if (initial === null || current === null) return unavailable('Leg geometry unavailable')
    speed = (current-initial)/1852/(elapsed/3600000)
  }
  if (provisional && (!Number.isFinite(speed) || speed < .5 || speed > 30)) return unavailable('Collecting leg average; plan speed unavailable')
  if (!Number.isFinite(speed)) return unavailable('Leg average unavailable')
  const base = { vmgKn: speed, timeToGo: null, eta: null, etaReason: null, etaProvisional: provisional }
  if (!(speed > 0)) return { ...base, etaReason: 'No positive leg progress' }
  if (speed > 30) return { ...base, etaReason: 'Leg average outside sailing range' }
  const seconds = distanceNm/speed*3600
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_ETA_SECONDS) return { ...base, etaReason: 'ETA outside live horizon' }
  const at = now+seconds*1000
  if (!Number.isFinite(new Date(at).getTime())) return { ...base, etaReason: 'ETA date unavailable' }
  return { ...base, timeToGo: seconds, eta: new Date(at).toISOString(), etaReason: provisional ? 'Provisional · leg plan speed' : null }
}
