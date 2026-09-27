// Durable-track display helpers. The plugin reconstructs the current recording
// from durable local storage; the browser only orders, bounds and appends. It
// never treats page-open time as the start of the trip and never mutates the raw
// recording.
export const MAX_DISPLAY_TRACK_POINTS = 2000

export function trackCoordinates(points) {
  if (!Array.isArray(points)) return []
  return points
    .filter((point) => point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((point) => [point.latitude, point.longitude])
}

export function appendTrackPoint(track, point, maxPoints = MAX_DISPLAY_TRACK_POINTS) {
  if (!Array.isArray(track) || !point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return track || []
  const last = track[track.length - 1]
  if (last && last[0] === point[0] && last[1] === point[1]) return track
  const next = [...track, point]
  return next.length > maxPoints ? next.slice(-maxPoints) : next
}

export function bootstrapTrack(response) {
  if (!response || !Array.isArray(response.points)) return []
  return trackCoordinates(response.points).slice(-MAX_DISPLAY_TRACK_POINTS)
}
