import { legAverageEta } from './leg-eta.mjs'
import { parseSignalKTimestamp, INSTRUMENT_STALE_SECONDS, MAX_INPUT_SKEW_SECONDS } from './instruments.mjs'
const value = (input) => input && typeof input === 'object' && 'value' in input ? input.value : input
const finite = (input) => typeof value(input) === 'number' && Number.isFinite(value(input)) ? value(input) : null
const radiansToDegrees = (input) => input === null ? null : ((input * 180 / Math.PI) % 360 + 360) % 360
const EARTH_RADIUS_M = 6371000

// Great-circle distance and initial bearing between two WGS84 points. Used only
// for the read-only fallback, so the next-mark bearing/distance stay visible
// while native activation is unavailable.
function greatCircle(from, to) {
  const radians = (degrees) => degrees * Math.PI / 180
  const latitude1 = radians(from.latitude)
  const latitude2 = radians(to.latitude)
  const deltaLatitude = latitude2 - latitude1
  const deltaLongitude = radians(to.longitude - from.longitude)
  const haversine = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2
  const centralAngle = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  const x = Math.sin(deltaLongitude) * Math.cos(latitude2)
  const y = Math.cos(latitude1) * Math.sin(latitude2) - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude)
  return { distanceM: EARTH_RADIUS_M * centralAngle, bearingDeg: (Math.atan2(x, y) * 180 / Math.PI + 360) % 360 }
}

// Distance-weighted progress along the active leg, clamped at its endpoints.
// This is presentation only: reaching 100% never advances a native waypoint.
export function courseProgressPercent(points, index, position) {
  const valid = p => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
    && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180
  if (points.length < 2 || !Number.isInteger(index) || index < 0 || index >= points.length || !points.every(valid)) return null
  if (index === 0) return 0
  if (!valid(position)) return null
  const legs = points.slice(1).map((p, i) => greatCircle(points[i], p))
  const total = legs.reduce((sum, leg) => sum + leg.distanceM, 0)
  if (!(total > 0)) return null
  const from = greatCircle(points[index - 1], position)
  const leg = legs[index - 1]
  const along = EARTH_RADIUS_M * Math.atan2(Math.sin(from.distanceM / EARTH_RADIUS_M)
    * Math.cos((from.bearingDeg - leg.bearingDeg) * Math.PI / 180), Math.cos(from.distanceM / EARTH_RADIUS_M))
  const completed = legs.slice(0, index - 1).reduce((sum, part) => sum + part.distanceM, 0)
    + Math.max(0, Math.min(leg.distanceM, along))
  return Math.round(completed / total * 100)
}

export function coursePoints(course) {
  if (!course || course.action === 'clear') return []
  return [course.start, ...(course.marks || []), course.finish].filter(Boolean)
}

// Course and Race Pack revision numbers belong to separate streams. Use their
// timestamps and plan identities when a pack arrives before its course.
export function selectedCoursePresentation(status, racePlan = null) {
  const desired = status?.desired || status?.cachedCourse
  const pack = racePlan?.pack
  const packTime = Date.parse(pack?.generatedAt)
  const desiredTime = Date.parse(desired?.updatedAt)
  const different = desired?.action !== 'activate' || pack?.courseId !== desired.courseId
    || (pack?.racePlanId != null && desired.racePlanId != null && pack.racePlanId !== desired.racePlanId)
  const pendingPack = pack?.available === true && !!pack.courseName && different && Number.isFinite(packTime)
    && (!desired || (Number.isFinite(desiredTime) && packTime > desiredTime))
  const course = pendingPack ? null : desired
  const name = pendingPack ? pack.courseName : course?.action === 'activate' ? course.name : 'Onboard navigation'
  const matchingPack = pack?.available === true && !different
  const startTime = pendingPack || matchingPack ? pack.startTime : null
  const date = startTime && Number.isFinite(Date.parse(startTime)) ? new Date(startTime).toLocaleDateString() : null
  // Keep the canonical name intact and show the race date even for names which
  // do not contain it (for example, "Club race").
  return { course, pendingPack, name: date ? `${name} · ${date}` : name }
}

export function raceProgress(status, navigation = {}, calculated = {}, nativeRoute = null, racePlan = null, now = Date.now()) {
  const desired = selectedCoursePresentation(status, racePlan).course
  const cachedPoints = coursePoints(desired)
  const geometry = nativeRoute?.feature?.geometry
  const nativeCoordinates = geometry?.type === 'LineString' && Array.isArray(geometry.coordinates) ? geometry.coordinates : null
  const validNative = status?.native?.activeMatchesDesired === true && cachedPoints.length > 0 && nativeCoordinates?.length >= 2 && nativeCoordinates.length <= 200
    && nativeCoordinates.every(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)
  const resourcePoints = validNative ? nativeCoordinates.map((point, index) => ({
    ...cachedPoints[index], latitude: point[1], longitude: point[0],
    name: nativeRoute.feature.properties?.coordinatesMeta?.[index]?.name || cachedPoints[index]?.name || `Point ${index + 1}`,
  })) : cachedPoints
  const course = status?.native?.course
  const matches = desired?.action !== 'clear' && cachedPoints.length > 0 && status?.native?.activeMatchesDesired === true
  const reverse = matches && course?.activeRoute?.reverse === true
  const points = reverse ? [...resourcePoints].reverse() : resourcePoints
  const rawIndex = course?.activeRoute?.pointIndex
  const nativeIndex = matches && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < points.length ? rawIndex : null
  // Read-only fallback: native activation is unavailable, rejected or
  // conflicted, but a cached Wake Logger course exists. Navigation stays
  // visible from the cached points. Control writes remain gated on `matches`.
  const readOnly = !matches && desired?.action !== 'clear' && points.length >= 2
  const cachedIndex = Number.isInteger(desired?.activeWaypointIndex) && desired.activeWaypointIndex >= 0 && desired.activeWaypointIndex < points.length
    ? desired.activeWaypointIndex
    : Math.min(1, points.length - 1)
  const index = matches ? nativeIndex : readOnly ? cachedIndex : null
  const previousIndex = index === null ? -1 : index - 1
  const position = value(navigation.position)
  const validPosition = position && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
    && Math.abs(position.latitude) <= 90 && Math.abs(position.longitude) <= 180
  const timestamp = navigation.position?.timestamp
  const positionTime = parseSignalKTimestamp(timestamp)
  const positionCurrent = timestamp === undefined || (positionTime !== null
    && positionTime <= now + 5000 && now - positionTime <= INSTRUMENT_STALE_SECONDS * 1000)
  const next = index === null ? null : points[index]
  const fallback = readOnly && validPosition && next ? greatCircle(position, next) : null
  // Signal K supplies the calculations when the route is active. Only units and
  // presentation change there; the fallback computes directly from cached
  // geometry so a missing native route never blanks live navigation.
  // The v2 calculation API strips source envelopes. The v1 navigation tree
  // retains navigation.course.calcValues timestamps when the provider emits them.
  if (matches && navigation.course?.calcValues) calculated = navigation.course.calcValues
  const distanceM = matches ? finite(calculated.distance) : fallback ? fallback.distanceM : null
  const bearingRad = matches ? finite(calculated.bearingTrue) : null
  const distanceNm = distanceM === null ? null : distanceM / 1852
  const bearingDeg = matches ? radiansToDegrees(bearingRad) : fallback ? fallback.bearingDeg : null
  const cogDeg = radiansToDegrees(finite(navigation.courseOverGroundTrue))
  const sogMps = finite(navigation.speedOverGround)
  // Native TTG/ETA/VMG are intentionally not inputs to leg-average ETA.
  const required = matches
    ? [navigation.position, navigation.speedOverGround, navigation.courseOverGroundTrue, calculated.distance, calculated.bearingTrue]
    : [navigation.position, navigation.speedOverGround, navigation.courseOverGroundTrue]
  const times = required.map(entry => parseSignalKTimestamp(entry?.timestamp))
  let etaReason = null
  if (!Number.isFinite(now) || !validPosition || !next || distanceNm === null || distanceNm < 0 || bearingDeg === null || sogMps === null || sogMps < 0 || cogDeg === null) etaReason = 'Navigation inputs unavailable'
  else if (times.some(time => time === null || time > now + 5000 || now - time > INSTRUMENT_STALE_SECONDS * 1000)) etaReason = 'Fresh navigation inputs unavailable'
  else if (Math.max(...times) - Math.min(...times) > MAX_INPUT_SKEW_SECONDS * 1000) etaReason = 'Navigation inputs out of sync'
  const identity = JSON.stringify([desired?.courseId, desired?.revision, desired?.updatedAt, index, matches ? course?.activeRoute?.href : 'cached', reverse, cachedPoints])
  const geometryMatches = !validNative || resourcePoints.length === cachedPoints.length && resourcePoints.every((p, i) => p.latitude === cachedPoints[i].latitude && p.longitude === cachedPoints[i].longitude)
  const marker = geometryMatches && status?.legStart?.identity === identity ? status.legStart : null
  const snapshot = racePlan?.latestSnapshot
  const leg = snapshot?.plan?.legs?.[0]
  const fallbackKn = racePlan?.pack?.applicable === true && racePlan?.pack?.courseId === desired?.courseId
    && snapshot?.tracking?.courseId === desired?.courseId && snapshot?.tracking?.activeIndex === index
    && snapshot?.tracking?.reverse === reverse && snapshot?.packRevision === racePlan?.pack?.revision
    && Number.isFinite(snapshot?.generatedAt) && snapshot.generatedAt <= now && now - snapshot.generatedAt <= 20*60*1000
    ? leg?.estimatedSogKnots : null
  const estimate = etaReason ? { vmgKn: null, timeToGo: null, eta: null, etaProvisional: false }
    : legAverageEta({ marker, origin: previousIndex >= 0 ? points[previousIndex] : null, target: next,
      position, positionTime, distanceNm, now, fallbackKn })
  etaReason ||= estimate.etaReason
  const { vmgKn, timeToGo, eta, etaProvisional } = estimate
  return {
    points, index, matches, reverse, routeSource: validNative ? 'signalk' : 'cached',
    readOnly, navSource: matches ? 'signalk' : readOnly ? 'cached' : 'none',
    next,
    previous: previousIndex >= 0 && previousIndex < points.length ? points[previousIndex] : null,
    pointPercent: courseProgressPercent(points, index, validPosition && positionCurrent ? position : null),
    position: validPosition ? position : null,
    direction: radiansToDegrees(finite(navigation.headingTrue) ?? finite(navigation.courseOverGroundTrue)),
    distanceNm,
    bearingDeg,
    xteM: matches ? finite(calculated.crossTrackError) : null,
    vmgKn,
    timeToGo,
    eta, etaReason, etaProvisional,
  }
}
