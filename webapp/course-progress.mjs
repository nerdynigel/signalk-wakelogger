const value = (input) => input && typeof input === 'object' && 'value' in input ? input.value : input
const finite = (input) => typeof value(input) === 'number' && Number.isFinite(value(input)) ? value(input) : null
const radiansToDegrees = (input) => input === null ? null : ((input * 180 / Math.PI) % 360 + 360) % 360

export function coursePoints(course) {
  if (!course || course.action === 'clear') return []
  return [course.start, ...(course.marks || []), course.finish].filter(Boolean)
}

export function raceProgress(status, navigation = {}, calculated = {}, nativeRoute = null) {
  const desired = status?.desired?.action === 'clear' ? status.desired : status?.cachedCourse || status?.desired
  const cachedPoints = coursePoints(desired)
  const geometry = nativeRoute?.feature?.geometry
  const nativeCoordinates = geometry?.type === 'LineString' && Array.isArray(geometry.coordinates) ? geometry.coordinates : null
  const validNative = cachedPoints.length > 0 && nativeCoordinates?.length >= 2 && nativeCoordinates.length <= 200
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
  const index = matches && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < points.length ? rawIndex : null
  const previousIndex = index === null ? -1 : index - 1
  const position = value(navigation.position)
  const validPosition = position && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
    && Math.abs(position.latitude) <= 90 && Math.abs(position.longitude) <= 180
  // Signal K supplies the calculations. Only units and presentation change here.
  const distance = matches ? finite(calculated.distance) : null
  const bearing = matches ? finite(calculated.bearingTrue) : null
  const vmg = matches ? finite(calculated.velocityMadeGood) : null
  return {
    points, index, matches, reverse, routeSource: validNative ? 'signalk' : 'cached',
    next: index === null ? null : points[index],
    previous: previousIndex >= 0 && previousIndex < points.length ? points[previousIndex] : null,
    pointPercent: index === null || points.length < 2 ? null : Math.round(index * 100 / (points.length - 1)),
    position: validPosition ? position : null,
    direction: radiansToDegrees(finite(navigation.headingTrue) ?? finite(navigation.courseOverGroundTrue)),
    distanceNm: distance === null ? null : distance / 1852,
    bearingDeg: radiansToDegrees(bearing),
    xteM: matches ? finite(calculated.crossTrackError) : null,
    vmgKn: vmg === null ? null : vmg / 0.5144444444,
    timeToGo: matches ? finite(calculated.timeToGo) : null,
    eta: matches ? value(calculated.estimatedTimeOfArrival) || null : null,
  }
}
