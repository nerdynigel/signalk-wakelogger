# Onboard navigation and offline maps

Open **Wake Logger** in Signal K's Web Apps list, or `/signalk-wakelogger/` on
the boat's Signal K server. JavaScript, styles, Leaflet and its assets ship in
the npm package; there are no CDN dependencies. Sign in to the local Signal K
server. The session token is separate from course state and is kept only in
session storage. MQTT/device credentials are never sent to the browser.

## Ownership and navigation

Wake Logger owns the race/course definition and race metadata, including mark
notes. Signal K owns the onboard route resource, active course, vessel navigation,
standard course calculations, chart resources, and chart serving/caching.

Cloud selection publishes a retained desired document with a monotonically
increasing device revision. The plugin validates and persists it, writes a
deterministic managed native route, confirms read-back, and acknowledges the
result. See [course-sync.md](course-sync.md) for protocol details. Repeated
delivery does not create duplicate routes. Invalid documents retain the previous
course. Other applications' routes are never overwritten or deleted.

The map reads the managed route from the native Resources API; the last valid
cached Wake Logger geometry is a fallback if that resource is temporarily
unavailable. Point index and direction come from Signal K's active course. An
active route selected by another app is shown as a conflict; Wake Logger does not
continually reclaim it. **Activate Wake Logger course** is an explicit takeover.
**Set point** and **Advance point** call the native Course API through the
isolated `CourseProgressionService`, after checking which route is active.

Distance, bearing, cross-track error, VMG, ETA and time-to-go come from the native
Course API `calcValues`. Only SI-to-display-unit conversion occurs in the UI.
Missing values stay unavailable. Course progress is explicitly progress through
route points, not a manufactured percentage of distance travelled. Reversed
routes use native traversal indices. Missing heading/COG shows a vessel dot,
not an invented north-facing heading. The displayed vessel trail is a bounded
browser-session trail; durable voyage history is handled by the recording outbox.

No arrival-circle, rounding-side, start-line or finish-line progression engine is
added. Future race-specific progression can replace the service's manual command
policy without duplicating Signal K's ordinary navigation calculations.

## Chart discovery and readiness

`ChartSourceService` discovers `/signalk/v2/api/resources/charts` and uses each
resource's supplied URL, bounds and zoom metadata. Native XYZ tiles are used for
local/proxied raster sources; direct WMS is supported separately. Proxied WMS and
WMTS with XYZ URL templates use ordinary tile layers. Native chart endpoints
already handle MBTiles/TMS conversion. Unsupported vector styles or direct WMTS
are omitted rather than rendered incorrectly.

The default source preference is suitable local charts, then Signal K's cached
or proxied sources. An external online source requires explicit selection. With
no chart provider or failed tiles, course geometry, vessel, marks, highlighted
leg and progression still work. Map imagery never travels through MQTT.

For local, non-proxied raster charts, **Verify local chart coverage** checks every
tile in the course bounding box plus the selected 5–20 km margin over the selected
zoom range. It bounds the plan to 1,000 tiles and limits bytes read (default
100 MB, configurable 1–500 MB), supports cancellation, and avoids repeating
recently verified reads. A missing/empty tile or limit failure prevents an
offline-ready result. The displayed MB count is bytes verified, not total chart
cache size. Readiness covers only the stated area and zoom range, at verification
time. Changing course/source/margin invalidates the report.

The plugin persists a small revision-keyed map-readiness result and includes it
in course acknowledgements. In local-only upload mode it is queued until cloud
transmission resumes. The cloud displays readiness as last reported information.
Install suitable licensed local MBTiles through Signal K Charts before departure;
Wake Logger does not install a second tile server.

## Optional race-area prefetch design

The current [Signal K Charts implementation](https://github.com/SignalK/charts-plugin)
has a native cache-job API: preview `POST /signalk/chart-tiles/cache/{identifier}`
with `bbox`, `minZoom`, `maxZoom`, then start/stop a job through
`POST /signalk/chart-tiles/cache/jobs/{id}`. Wake Logger can discover and display
those jobs and explicitly request cancellation. It does not automatically start
them in this phase.

Two constraints prevent a trustworthy, bounded prefetch implementation using
that API today: the downloader has fixed concurrency rather than configurable
rate/byte limits, and cache-write errors can be logged without failing the tile
transfer. Consequently, completed transfer counts do not prove persistent
offline coverage. Normal tile requests also lack a cache-only verification mode.
See the [downloader implementation](https://github.com/SignalK/charts-plugin/blob/master/src/chartDownloader.ts)
and [tile endpoint](https://github.com/SignalK/charts-plugin/blob/master/src/tileServer.ts).

The isolated future `RaceAreaPrefetchService` should use this contract:

1. Require an explicitly allowed chart source, licensing/terms reference,
   rate limit, byte quota and chosen zoom range. Default to disabled. Discovery
   or a public URL alone never grants bulk-download permission.
2. Plan the course bounds plus margin, splitting dateline regions, rejecting
   excessive tile counts and estimating storage before any request.
3. Feature-detect provider support for quota/rate-controlled jobs and durable
   per-tile verification. Prefer those native jobs when available.
4. Otherwise, use a bounded resumable worker requesting only the normal local
   Signal K chart endpoint. Require provider-enforced cache quotas and a cache-only
   lookup/verification capability first; do not create a parallel cache server.
5. Persist a non-secret job manifest keyed by chart ID/revision and tile
   coordinates, recording verified cached tiles. Apply a token-bucket request
   limit, stop before the byte quota, cancel outstanding requests, and resume
   missing tiles only. A changed provider URL/revision invalidates old evidence.
6. Report planned, verified, failed and remaining tiles, measured cache bytes,
   cancellation/failure state, and verification time. Declare offline ready only
   after persistent coverage is verified with upstream access disabled or through
   a provider cache-only interface.

Until the provider offers those guarantees, local MBTiles plus bounded local
coverage verification is the supported offline-preparation path. This avoids
uncontrolled or unlicensed downloads and misleading readiness claims.

## Validation and deployment

The integration target is Signal K 2.31.1 with its native resource and course
providers. The inspected development server has no Charts plugin installed;
chart discovery, geometry-only fallback, local tiles, controls and error states
are covered in browser tests using local HTTP fixtures. Actual native routes and
course activation are exercised by the packaged Signal K Docker test.

Deploy Wake Logger migrations `0092` (recordings) and `0093` (course sync), API
and MQTT ACL updates before releasing the new plugin. No additional cloud tile
service is required. Upgrade/install Signal K Charts separately and provide
licensed local charts; neither cloud course synchronisation nor plugin updates
can manufacture offline chart coverage.
