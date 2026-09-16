# Course delivery and native Signal K navigation

Wake Logger publishes the vessel's selected race course to the retained device
`/course` topic. The plugin validates and saves the desired revision locally,
creates or updates a route using Signal K's native Resources API, and reports
`applied` or `rejected` on `/course-ack`. Map files never travel over MQTT.

The v1 document contains `action: activate`, `courseId`, positive monotonic
`revision`, `name`, ISO `updatedAt`, `start`, `marks`, and `finish`. Each point has
an occurrence `id`, `name`, `latitude`, and `longitude`, with optional `notes` (up to 1,000 characters) for rounding or other instructions. Optional
`activeWaypointIndex` is zero based. There are at most 200 total points and the
encoded document is at most 64 KiB. Coordinates must be finite and in range;
point occurrence IDs are unique even when the same physical mark is rounded
twice. A clear document contains `action: clear`, `courseId: null`, revision,
and updatedAt. Older revisions and different content at an existing revision
are rejected without replacing the cached desired course.

A namespaced hash of courseId supplies a stable native route UUID, with the
version/variant shape accepted by the installed Signal K Resources validator.
The route's GeoJSON properties identify Wake Logger ownership, courseId and
revision; coordinatesMeta preserves the named marks. The plugin refuses to
overwrite a resource that lacks matching ownership metadata. Native resource
writes are read back before activation because Signal K 2.31's plugin wrapper
can return before its provider finishes writing.

Automatic delivery activates a new course only when no native route is active
or the active route is the previous Wake Logger-owned course. Another app's
active route remains active and the acknowledgement reports `conflict`.
**Activate course** is an explicit local action that selects the cached course.
Retained duplicate deliveries and restarts do not reset native progress. A new
revision of the same active course reloads its native route at the current point
(clamped to the new route length); Signal K supplies the native course behaviour.
Clear only deactivates the matching owned active course and retains route data.

## Local API and course progression

The plugin's Signal K router exposes:

- `GET /plugins/signalk-wakelogger/course`: desired and cached course, flattened
  route points, latest acknowledgement, upload mode, connection state, and native
  course/route identity, availability and conflict state.
- `POST /plugins/signalk-wakelogger/course/activate`: explicitly select the cached
  desired course through Signal K's native activation API.
- `POST /plugins/signalk-wakelogger/course/map-readiness`: save `{revision,status}`
  for the current desired revision. Status is `unknown`, `unavailable`,
  `online_only`, `preparing` or `offline_ready`; reports for stale revisions fail.

Onboard access uses Signal K's per-route access levels: the `GET` status route
accepts any signed-in user, `POST /course/activate` and
`POST /course/map-readiness` require the readwrite role (or an administrator),
and `POST /forget-credentials` remains administrator-only. Course progression
uses the authenticated native REST API directly:
`PUT /signalk/v2/api/vessels/self/navigation/course/activeRoute/pointIndex` with
`{value: zeroBasedIndex}`, or the native nextPoint action. There are no plugin
point/advance endpoints. The installed plugin API exposes activation but no
progression method; reactivation would reset native start time. The onboard UI
encapsulates the native progression calls and reads Signal K navigation metrics;
there is no second navigation engine or assumed race rounding radius.

Course data and chart readiness are separate. Readiness is saved against a course
revision and included in acknowledgements; it resets to unknown on a new desired
revision. The onboard map must verify chart coverage before reporting
`offline_ready`. In `local_only` mode native navigation and local API actions
remain available, while cloud acknowledgements wait until automatic uploading is
restored. Signal K persists its active course; the plugin independently persists
its desired course and acknowledgement with fsynced replacement files.
