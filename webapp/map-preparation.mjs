// Verify existing local charts. This never fetches an upstream map provider and
// deliberately does not treat an online/proxy download as proof of persistence.
export function tilePlan(bounds, minZoom, maxZoom, maximumTiles = 1000) {
  if (!bounds || !Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || minZoom < 0 || maxZoom > 18 || maxZoom < minZoom) throw new Error('Choose a valid chart zoom range.')
  const [west, south, east, north] = bounds
  if (![west, south, east, north].every(Number.isFinite) || west > east || south > north || south < -85 || north > 85 || west < -180 || east > 180) throw new Error('This course needs separate chart regions.')
  const tiles = []
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z
    const x = lon => Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n)))
    const y = lat => Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)))
    for (let tx = x(west); tx <= x(east); tx++) for (let ty = y(north); ty <= y(south); ty++) {
      if (tiles.length >= maximumTiles) throw new Error(`Area exceeds ${maximumTiles} tiles. Reduce the margin or maximum zoom.`)
      tiles.push({ x: tx, y: ty, z })
    }
  }
  return tiles
}

export class LocalChartVerifier {
  constructor() { this.controller = null; this.verified = new Map() }
  cancel() { this.controller?.abort() }
  async verify(chart, bounds, { minZoom = 8, maxZoom = 14, maxBytes = 100 * 1024 * 1024, onProgress = () => {} } = {}) {
    if (!chart.local || chart.type !== 'tilelayer') throw new Error('Select an existing local raster chart. Online cache coverage cannot be verified here.')
    if (!Number.isFinite(maxBytes) || maxBytes < 1024 * 1024 || maxBytes > 500 * 1024 * 1024) throw new Error('Verification limit must be 1–500 MB.')
    const tiles = tilePlan(bounds, Math.max(minZoom, chart.minZoom), Math.min(maxZoom, chart.maxZoom))
    this.cancel()
    const controller = new AbortController()
    this.controller = controller
    let checked = 0, bytes = 0
    for (const tile of tiles) {
      if (controller.signal.aborted) throw new DOMException('Verification cancelled', 'AbortError')
      const url = chart.url.replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y)
      const previous = this.verified.get(url)
      if (previous && Date.now() - previous.at < 5 * 60_000) bytes += previous.bytes
      else {
        const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || '')) throw new Error('A required local chart tile is unavailable.')
        const reader = response.body.getReader()
        let size = 0
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (bytes + size > maxBytes) { await reader.cancel(); throw new Error('Verification data limit reached. Reduce area or zoom.') }
          }
        } finally { reader.releaseLock() }
        if (!size) throw new Error('A local chart tile is empty.')
        bytes += size
        if (this.verified.size >= 1000) this.verified.delete(this.verified.keys().next().value)
        this.verified.set(url, { bytes: size, at: Date.now() })
      }
      if (bytes > maxBytes) throw new Error('Verification data limit reached.')
      checked++
      onProgress({ checked, total: tiles.length, bytes })
    }
    return { checked, total: tiles.length, bytes, bounds, minZoom: Math.max(minZoom, chart.minZoom), maxZoom: Math.min(maxZoom, chart.maxZoom) }
  }
}
