// Geographic geometry only. Callers supply bearings from validated live guides;
// these headings estimate tracks without current or leeway correction.
const R = 6371000;
const rad = value => value * Math.PI / 180;
const deg = value => value * 180 / Math.PI;
const wrap = value => ((value % 360) + 360) % 360;
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm = vector => Math.hypot(...vector);
const valid = point => point && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
  && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
const unit = point => {
  const lat = rad(point.latitude), lon = rad(point.longitude);
  return [Math.cos(lat)*Math.cos(lon), Math.cos(lat)*Math.sin(lon), Math.sin(lat)];
};
function plane(point, bearing) {
  const lat = rad(point.latitude), lon = rad(point.longitude), angle = rad(bearing);
  const north = [-Math.sin(lat)*Math.cos(lon), -Math.sin(lat)*Math.sin(lon), Math.cos(lat)];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  return cross(unit(point), north.map((value, i) => value*Math.cos(angle) + east[i]*Math.sin(angle)));
}
const along = (origin, point, normal) => Math.atan2(dot(cross(origin, point), normal), dot(origin, point));

export function projectLayline(position, bearingDeg, distanceM) {
  const lat = rad(position.latitude), lon = rad(position.longitude), bearing = rad(bearingDeg), angle = distanceM / R;
  const latitude = Math.asin(Math.max(-1, Math.min(1, Math.sin(lat)*Math.cos(angle) + Math.cos(lat)*Math.sin(angle)*Math.cos(bearing))));
  const longitude = lon + Math.atan2(Math.sin(bearing)*Math.sin(angle)*Math.cos(lat), Math.cos(angle)-Math.sin(lat)*Math.sin(latitude));
  return { latitude: deg(latitude), longitude: wrap(deg(longitude)+180)-180 };
}

// Sample the great-circle ray, keeping adjacent longitudes continuous for
// Leaflet and selecting the world copy nearest the current viewport.
export function laylineCoordinates(target, bearingDeg, distanceM, centerLongitude = target.longitude) {
  let longitude = target.longitude + Math.round((centerLongitude - target.longitude) / 360) * 360;
  return Array.from({ length: 33 }, (_, index) => {
    const point = projectLayline(target, bearingDeg, distanceM * index / 32);
    longitude = point.longitude + Math.round((longitude - point.longitude) / 360) * 360;
    return [point.latitude, longitude];
  });
}

export function waypointLaylines({ position, target, headingDeg, oppositeCourseDeg, currentTack, kind, trueWindFromDeg } = {}) {
  const empty = { status: 'unavailable', reason: 'Fresh sailing inputs and an active mark required', approaches: [], maneuverPoint: null, distanceM: null, kind: kind || null };
  if (!valid(position) || !valid(target) || !['tack', 'gybe'].includes(kind)
    || !['port', 'starboard'].includes(currentTack)
    || ![headingDeg, oppositeCourseDeg, trueWindFromDeg].every(Number.isFinite)) return empty;
  const origin = unit(position), destination = unit(target);
  if (norm(cross(origin, destination)) < 1e-10) return { ...empty, reason: 'At mark or ambiguous destination' };
  // A target on the wrong side of the wind cannot use this maneuver model.
  const lat = rad(position.latitude), lon = rad(position.longitude);
  const north = [-Math.sin(lat)*Math.cos(lon), -Math.sin(lat)*Math.sin(lon), Math.cos(lat)];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const targetBearing = wrap(deg(Math.atan2(dot(destination, east), dot(destination, north))));
  const windAngle = Math.abs(((targetBearing - trueWindFromDeg + 540) % 360) - 180);
  if (kind === 'tack' ? windAngle >= 90 : windAngle <= 90) return { ...empty, reason: 'Mark is outside this sailing mode' };
  const approaches = [
    { side: currentTack, bearingDeg: wrap(headingDeg), backBearingDeg: wrap(headingDeg + 180) },
    { side: currentTack === 'port' ? 'starboard' : 'port', bearingDeg: wrap(oppositeCourseDeg), backBearingDeg: wrap(oppositeCourseDeg + 180) },
  ];
  const result = { ...empty, status: 'no-forward-intersection', reason: `No forward ${kind} point`, approaches };
  const a = plane(position, headingDeg), b = plane(target, oppositeCourseDeg + 180);
  const intersection = cross(a, b), length = norm(intersection);
  if (length < 1e-8) return result;
  for (const sign of [1, -1]) {
    const point = intersection.map(value => value / length * sign);
    const forward = along(origin, point, a), backwardFromMark = along(destination, point, b);
    // Reject the remote antipodal solution, points behind either ray and
    // coincident tack/mark solutions. Zero distance at the boat is legitimate.
    if (forward < -1e-8 || forward >= Math.PI/2 || backwardFromMark <= 1e-8 || backwardFromMark >= Math.PI/2) continue;
    return { ...result, status: 'ready', reason: null,
      maneuverPoint: { latitude: deg(Math.asin(Math.max(-1, Math.min(1, point[2])))), longitude: deg(Math.atan2(point[1], point[0])) },
      distanceM: Math.max(0, forward) * R };
  }
  return result;
}
