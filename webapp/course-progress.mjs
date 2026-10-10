const value = (input) => input && typeof input === 'object' && 'value' in input ? input.value : input
const finite = (input) => typeof value(input) === 'number' && Number.isFinite(value(input)) ? value(input) : null
const radiansToDegrees = (input) => input === null ? null : ((input * 180 / Math.PI) % 360 + 360) % 360
const signedDegrees = (input) => ((input + 540) % 360) - 180
const MPS_TO_KNOTS = 1.9438444924406
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

export function raceProgress(status, navigation = {}, calculated = {}, nativeRoute = null, racePlan = null) {
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
  const next = index === null ? null : points[index]
  const fallback = readOnly && validPosition && next ? greatCircle(position, next) : null
  // Signal K supplies the calculations when the route is active. Only units and
  // presentation change there; the fallback computes directly from cached
  // geometry so a missing native route never blanks live navigation.
  const distanceM = matches ? finite(calculated.distance) : fallback ? fallback.distanceM : null
  const bearingRad = matches ? finite(calculated.bearingTrue) : null
  const distanceNm = distanceM === null ? null : distanceM / 1852
  const bearingDeg = matches ? radiansToDegrees(bearingRad) : fallback ? fallback.bearingDeg : null
  const cogDeg = radiansToDegrees(finite(navigation.courseOverGroundTrue))
  const sogMps = finite(navigation.speedOverGround)
  const sogKnots = sogMps === null ? null : sogMps * MPS_TO_KNOTS
  const vmgNative = matches ? finite(calculated.velocityMadeGood) : null
  const vmgKn = vmgNative !== null
    ? vmgNative / 0.5144444444
    : fallback && sogKnots !== null && cogDeg !== null && sogKnots > 0
      ? sogKnots * Math.cos(signedDegrees(fallback.bearingDeg - cogDeg) * Math.PI / 180)
      : null
  const timeToGo = matches
    ? finite(calculated.timeToGo)
    : distanceNm !== null && vmgKn !== null && vmgKn > 0 ? distanceNm / vmgKn * 3600 : null
  const eta = matches
    ? value(calculated.estimatedTimeOfArrival) || null
    : timeToGo !== null ? new Date(Date.now() + timeToGo * 1000).toISOString() : null
  return {
    points, index, matches, reverse, routeSource: validNative ? 'signalk' : 'cached',
    readOnly, navSource: matches ? 'signalk' : readOnly ? 'cached' : 'none',
    next,
    previous: previousIndex >= 0 && previousIndex < points.length ? points[previousIndex] : null,
    pointPercent: index === null || points.length < 2 ? null : Math.round(index * 100 / (points.length - 1)),
    position: validPosition ? position : null,
    direction: radiansToDegrees(finite(navigation.headingTrue) ?? finite(navigation.courseOverGroundTrue)),
    distanceNm,
    bearingDeg,
    xteM: matches ? finite(calculated.crossTrackError) : null,
    vmgKn,
    timeToGo,
    eta,
  }
}
