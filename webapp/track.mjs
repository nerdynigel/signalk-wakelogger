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

export function needsRebootstrap({
  trackLength,
  fixesSinceBootstrap = 0,
  threshold = REBOOTSTRAP_TAIL_THRESHOLD,
  recordingChanged = false,
  gapDetected = false,
  resumed = false
} = {}) {
  if (recordingChanged || gapDetected || resumed) return true
  if (!(Number.isFinite(trackLength) && trackLength > 0)) return true
  return fixesSinceBootstrap >= threshold
}
