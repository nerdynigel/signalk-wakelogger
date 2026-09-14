const TILE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp'])

export function chartSources(resources, origin = location.origin) {
  const rows = Array.isArray(resources) ? resources.map((row, i) => [String(i), row]) : Object.entries(resources || {})
  return rows.flatMap(([id, chart]) => {
    if (!chart || !['tilelayer', 'WMS', 'WMTS'].includes(chart.type) || !TILE_FORMATS.has(String(chart.format || 'png').toLowerCase())) return []
    const template = chart.url || chart.tilemapUrl
    if (typeof template !== 'string') return []
    let url
    try { url = new URL(template, origin) } catch { return [] }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []
    const sameOrigin = url.origin === origin
    const templatedTiles = ['{z}', '{x}', '{y}'].every(part => template.includes(part))
    if (chart.type === 'WMTS' && !templatedTiles) return []
    // Online sources require an explicit choice. No arbitrary third-party
    // basemap request is made merely because a resource happens to exist.
    const local = sameOrigin && url.pathname.startsWith('/signalk/chart-tiles/') && chart.proxy === false
    const cached = sameOrigin && chart.proxy === true
    return [{ id: chart.identifier || id, name: chart.name || id, url: template,
      type: templatedTiles ? 'tilelayer' : chart.type, layers: chart.layers || '', local, cached, online: !sameOrigin,
      bounds: Array.isArray(chart.bounds) && chart.bounds.length === 4 && chart.bounds.every(Number.isFinite) ? chart.bounds : null,
      minZoom: Number.isFinite(chart.minzoom) ? chart.minzoom : 0,
      maxZoom: Number.isFinite(chart.maxzoom) ? chart.maxzoom : 18,
      attribution: typeof chart.description === 'string' ? chart.description : '',
      priority: local ? 0 : cached ? 1 : sameOrigin ? 2 : 3 }]
  }).sort((a, b) => a.priority - b.priority)
}

export function courseBounds(points, marginKm = 10) {
  if (!points.length || !Number.isFinite(marginKm) || marginKm < 5 || marginKm > 20) return null
  const latitudes = points.map(p => p.latitude)
  const longitudes = points.map(p => p.longitude)
  if (![...latitudes, ...longitudes].every(Number.isFinite)) return null
  // Dateline-spanning courses need split regions. Refuse a world-sized cache job.
  if (Math.max(...longitudes) - Math.min(...longitudes) > 180) return null
  const latitude = (Math.max(...latitudes) + Math.min(...latitudes)) / 2
  const dLat = marginKm / 111.195
  const dLon = dLat / Math.max(0.01, Math.cos(latitude * Math.PI / 180))
  return [Math.max(-180, Math.min(...longitudes) - dLon), Math.max(-85, Math.min(...latitudes) - dLat),
    Math.min(180, Math.max(...longitudes) + dLon), Math.min(85, Math.max(...latitudes) + dLat)]
}

export function coversBounds(chart, bounds) {
  return Boolean(chart?.bounds && bounds && chart.bounds[0] <= bounds[0] && chart.bounds[1] <= bounds[1] && chart.bounds[2] >= bounds[2] && chart.bounds[3] >= bounds[3])
}

export class ChartSourceService {
  constructor(client) { this.client = client }
  async discover() { return chartSources(await this.client.request('/signalk/v2/api/resources/charts')) }
  async cacheJobs() {
    try { return await this.client.request('/signalk/chart-tiles/cache/jobs') }
    catch (error) { if ([404, 501].includes(error.status)) return null; throw error }
  }
  cancelJob(id) {
    return this.client.request(`/signalk/chart-tiles/cache/jobs/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) })
  }
}
