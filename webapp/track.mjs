// Durable-track display helpers. The plugin reconstructs the current recording
// from an independent durable archive; the browser only orders, bounds and
// appends. It never treats page-open time as the start of the trip, never drops
// the departure to stay under a cap, and re-bootstraps from the archive when the
// recording changes, a gap appears, the page resumes, or the local tail has
// grown enough that the whole-trip geometry should be recomputed.
export const MAX_DISPLAY_TRACK_POINTS = 2000
export const REBOOTSTRAP_TAIL_THRESHOLD = 250

export function trackCoordinates(points) {
  if (!Array.isArray(points)) return []
  return points
    .filter((point) => point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((point) => [point.latitude, point.longitude])
}

// The server already decimates to the display bound and always retains the
// first and last captured point, so a full-trip bootstrap must not slice off
// the beginning.
export function bootstrapTrack(response) {
  if (!response || !Array.isArray(response.points)) return []
  return trackCoordinates(response.points)
}

export function appendTrackPoint(track, point, maxPoints = MAX_DISPLAY_TRACK_POINTS) {
  if (!Array.isArray(track) || !point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return track || []
  if (track.length >= maxPoints) return track
  const last = track[track.length - 1]
  if (last && last[0] === point[0] && last[1] === point[1]) return track
  return [...track, point]
}

// Bounding box of a coordinate track, or null when it has no usable points.
// Used to fit the map to the whole recorded passage independently of when the
// browser connected.
export function trackBounds(points) {
  if (!Array.isArray(points) || !points.length) return null
  let south = Infinity
  let west = Infinity
  let north = -Infinity
  let east = -Infinity
  for (const point of points) {
    if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue
    if (point[0] < south) south = point[0]
    if (point[0] > north) north = point[0]
    if (point[1] < west) west = point[1]
    if (point[1] > east) east = point[1]
  }
  if (!Number.isFinite(south) || !Number.isFinite(west) || !Number.isFinite(north) || !Number.isFinite(east)) return null
  return { south, west, north, east }
}

// The map should fit the full available track when a passage's history first
// loads or is recomputed, unless the user has already taken manual control of
// the viewport. A new recording id is a new passage and re-enables fitting, so
// opening another client or changing upload mode never changes the extent.
export function shouldAutoFitTrack({ hasTrack, recordingChanged = false, userControlled = false, mode = 'track' } = {}) {
  if (!hasTrack) return false
  if (recordingChanged) return true
  if (userControlled) return false
  // 'auto' means no explicit viewport choice yet, so the arrival of durable
  // history may still frame the full track. 'course'/'follow'/'manual' are
  // deliberate choices and are left alone.
  return mode === 'auto' || mode === 'track'
}

export function needsRebootstrap({
  trackLength,
  fixesSinceBootstrap = 0,
  threshold = REBOOTSTRAP_TAIL_THRESHOLD,
  recordingChanged = false,
  gapDetected = false,
  resumed = false,
  historyEmpty = false
} = {}) {
  if (recordingChanged || gapDetected || resumed) return true
  if (!(Number.isFinite(trackLength) && trackLength > 0)) return true
  // An empty/failed initial archive response must not be treated as the whole
  // recording just because the browser has since drawn its own tail; reconcile
  // on the next poll instead of waiting for the full tail threshold.
  if (historyEmpty) return true
  return fixesSinceBootstrap >= threshold
}
