# Onboard race guidance: mark detection and sail plan

Design for two related onboard features. Both work fully on the boat; the cloud
remains authoritative for post-race review. No AI runs on the vessel.

## Implementation status

All four rollout phases below are implemented in the plugin, the onboard app
and the automated test suite. The cloud/web side that builds and publishes the
Race Pack is owned by the separate `wakelogger` repository; this document
records the wire contract the plugin consumes.

Implemented:

- Mark detection and race progression (`src/race/detection.ts`,
  `src/race/progression-store.ts`, `src/race/progression-service.ts`) with
  Auto/Suggest/Off modes, evidence events on the existing events topic and
  native `nextPoint` advancement from the onboard app.
- Deterministic sail-plan port with golden-fixture parity
  (`src/race/sailing/physics.ts`, `src/race/sailing/selection.ts`,
  `test/fixtures/sail-physics.json`) and the onboard planner
  (`src/race/plan.ts`).
- Race Pack protocol v1 receiver (`src/race/race-pack-protocol.ts`):
  manifest/chunk validation, bounded gzip+base64 decode, SHA-256 verification,
  schema and identity validation, and ACK construction.
- Durable Race Pack store (`src/race/race-pack-store.ts`): immutable versioned
  pack files plus an atomically replaced metadata document, restart recovery,
  stale-revision rollback protection.
- Local five-minute observations (`src/race/observations.ts`) with direct true
  wind and deterministic apparent-to-true derivation.
- Onboard scheduler and authority service (`src/race/onboard-service.ts`) and
  durable snapshot queue (`src/race/onboard-store.ts`).
- Transport wiring for the retained Race Pack topics, retained ACK and
  delayed `race_plan_snapshot` upload (`src/transport/mqtt-client.ts`,
  `src/transport/topics.ts`).
- Read-only API `GET /plugins/signalk-wakelogger/race-plan`, explicit local
  recalculation `POST /plugins/signalk-wakelogger/race-plan/recalculate` and
  the onboard Race panel.

Known constraint (unchanged): Signal K publishes no plugin API to change the
active route point index. `app.activateRoute()` resets the native course start
time, so the plugin must not use it for advancement. Auto therefore requires
the onboard app to be open with a signed-in user; otherwise detections wait as
pending until it reconnects. Upstreaming a small point-index API would remove
that requirement.

## Calculation authority

There is one deterministic Race Plan system with two calculation authorities.

- **Live tracking ON** (`uploadMode: automatic`): the Wake Logger cloud is the
  authority. The plugin continues recording and uploading telemetry, retains
  the latest Race Pack for later offline use, and does **not** run the onboard
  scheduler. A temporary internet outage does **not** transfer authority.
- **Live tracking OFF** (`uploadMode: local_only`): the vessel is the
  authority. The plugin stops all Wake Logger network traffic, keeps recording
  locally, calculates from the last fully validated Race Pack, and recalculates
  every 15 minutes while the race is under way and the pack applies to the
  active course.

Authority follows the user's Live tracking setting only. Switching
`automatic → local_only` transfers authority immediately; if an applicable pack
exists the plugin calculates at once and then resumes the 15-minute cadence.
Switching `local_only → automatic` stops the onboard scheduler immediately and
never deletes the cached pack or the historical onboard snapshots. There is no
`upload_only` mode and no separate post-race upload workflow; the existing
durable outbox uploads recorded history when Live tracking is restored.

## Race Pack wire protocol v1

Base topic: `wakelogger/v1/devices/{deviceId}`. QoS 1 throughout.

| Direction | Topic | Retained |
| --- | --- | --- |
| downlink | `.../race-pack/manifest` | yes |
| downlink | `.../race-pack/chunk/{index}` | yes |
| uplink | `.../race-pack-ack` | yes |

The cloud gzips one canonical JSON Race Pack, base64-encodes it and splits the
base64 string into bounded chunks. The plugin concatenates the `data` fragments
in index order, base64-decodes, gunzips with an output bound, verifies the
SHA-256 of the decompressed bytes, and only then parses JSON.

Manifest:

```json
{
  "v": 1,
  "packId": "<opaque immutable pack id>",
  "revision": 1,
  "racePlanId": 123,
  "generatedAt": "<ISO-8601>",
  "validFrom": "<ISO-8601|null>",
  "validUntil": "<ISO-8601|null>",
  "ruleSetVersion": "<version>",
  "encoding": "gzip+base64",
  "chunkCount": 4,
  "sha256": "<digest of canonical uncompressed JSON>"
}
```

Chunk:

```json
{ "v": 1, "packId": "<same>", "revision": 1, "index": 0, "chunkCount": 4, "data": "<base64 fragment>" }
```

ACK:

```json
{
  "v": 1, "packId": "<same>", "revision": 1, "sha256": "<same>",
  "status": "applied", "appliedAt": "<ISO-8601>", "errorCode": null
}
```

`status` may be `rejected` with a bounded `errorCode`.

Bounds enforced by the receiver (see `docs/race-pack-schema.md` for the exact
constants and the canonical schema): manifest ≤ 8 KiB, complete serialised
chunk message ≤ 64 KiB with a `data` fragment ≤ 48 KiB of base64 characters
(divisible by 4), ≤ 64 chunks, compressed pack ≤ 256 KiB, uncompressed pack
≤ 1 MiB, unlimited sampled forecast time series up to the pack cap, and at most
4 partial packs buffered at once.

Race Pack content (the canonical JSON) consumed by the plugin: versioned pack
identity, course points with kind/rounding/gate/line metadata, sail inventory,
optional race headsail, plan payload (start time, crew count, jib-change flag
and related configuration), a per-leg forecast time series
(`forecast.legs[].samples[]`), forecast snapshot metadata, polar summary and
rule-set version. Every course leg must have its own forecast series; a single
sample per leg is rejected as `forecast_timeline_insufficient`. Optional
`validFrom`/`validUntil` and `racePlanId` are cross-checked between the manifest
and the pack. The plugin makes no cloud reads after applying a pack.

## Supported rule set

The only supported rule set is `race_plan_dynamic_v1`, which defines:

- current/next leg uses the local five-minute observed window;
- each later leg selects, from **that leg's own** forecast series, the sample
  whose timestamp is nearest the leg's recalculated midpoint ETA;
- no cross-leg forecast substitution.

A manifest or pack advertising any other `ruleSetVersion` is rejected with
`unsupported_rule_set` and never replaces the applied pack. The plugin does not
claim parity with the cloud `race_plan_preview_v1` algorithm; cross-repo parity
is pending an authoritative golden fixture produced by the Wake Logger
implementation.

## ACK and persistence behaviour

- The plugin subscribes to the manifest and chunk topics whenever the automatic
  transport is connected, and re-subscribes after every reconnect.
- Chunks may arrive out of order, may arrive before the manifest, and may be
  duplicated. Only chunks matching one `packId`, `revision` and `chunkCount`
  are assembled; a duplicate chunk is idempotent; a conflicting chunk is
  rejected.
- Packs are written to immutable files (`<packId>-<revision>.bin`) and only then
  referenced by an atomically replaced `current.json` (write, `fsync`, rename,
  directory `fsync`). A crash can never replace a known-good pack with an
  incomplete one.
- A newer incomplete pack never removes the usable pack. A stale revision
  (`revision < applied.revision`) is rejected and cannot roll back. The same
  revision is accepted only when it is byte-for-byte the same immutable pack;
  otherwise it is a `revision_conflict`.
- The ACK is published only after the new pack has been validated and durably
  persisted. The last applied ACK is re-published (retained) after reconnect so
  the cloud can recover from a lost acknowledgement.
- Pack state is stored under
  `<plugin data>/race-packs/<deviceId>/{current.json,<packId>-<revision>.bin}`.

## Five-minute observations

`src/race/observations.ts` maintains a separate local observation collector; the
cloud telemetry schema is intentionally unchanged.

Collected Signal K paths when available (missing paths are simply skipped, never
fabricated):

- `navigation.position`
- `navigation.speedOverGround`, `navigation.courseOverGroundTrue`
  (`courseOverGroundMagnetic` fallback)
- `navigation.headingTrue` (`headingMagnetic` fallback)
- `navigation.speedThroughWater`
- `navigation.attitude` (heel/roll)
- `environment.wind.speedTrue`, `environment.wind.directionTrue`
- `environment.wind.speedApparent`, `environment.wind.angleApparent` and
  `environment.wind.directionApparent` as fallback inputs

Values older than 30 seconds are treated as stale. A five-minute rolling window
keeps circular averages for angles and scalar averages for speeds. When direct
true wind is missing the plugin derives it deterministically from apparent wind
plus heading and speed through water (or course and speed over ground), using
the same vector convention as the ported sail physics. Derivation is skipped
with clean nulls when there is not enough credible data.

## Scheduler and forecast lookup

The onboard service recalculates when all of the following are true:

- `uploadMode === "local_only"` (authority `onboard`)
- a fully validated Race Pack is stored
- the pack's course identity matches the selected/native course
- the pack is not outside its validity window
- the race/trip is under way (native course point advanced past the start, or
  the trip state is `MOVING`)
- a position exists and either observed wind or a forecast timeline is available
- at least 15 minutes have elapsed since the last routine calculation, unless
  an explicit recalculation is requested

Failure reasons are exposed verbatim (`no_race_pack`, `no_active_course`,
`pack_not_applicable`, `pack_expired`, `not_racing`,
`insufficient_observations`, `recent_calculation`, `cloud_authority`). Partial
forecast coverage and observation fallback are exposed separately as
`warning` / `forecastCoverage` / `observationsReady` on the same status.

Current/next leg: once the rolling window holds a complete, fresh wind
observation set (at least three fresh samples with credible true wind, direct
or derived) the plan uses the observed true wind plus the live position and
active course point. Until then it falls back to the current leg's downloaded
forecast at the calculated time, is labelled `source: "forecast"`, and warns
`Fresh onboard observations not yet available`. Partial or bad data is never
treated as a complete five-minute window, and observations are never
fabricated. Once the window is ready the next recalculation switches the
current leg to `source: "observed"`.

Future legs: the planner walks the remaining course, accumulates ETA, and for
each future leg selects, from **that leg's own** forecast time series, the
sample nearest that leg's recalculated midpoint time. The forecast lookup
therefore moves as ETA changes: if actual progress pushes Leg 5 from 13:40 to
14:20, the 14:20 sample from Leg 5's series is used. A leg never borrows another
leg's forecast because its timestamp happens to be closer, and the current
observation is never applied unchanged to future legs. This temporal rule is
frozen as `race_plan_dynamic_v1`; it is tested against a slow/fast progress
scenario that moves a leg from a 13:00 forecast to a 15:00 forecast.

Forecast coverage: every remaining leg must carry a real time series (at least
two samples, gaps no larger than 6 h) covering the declared window
(`forecast.coverage`, else `validFrom`/`validUntil`) within a 6 h tolerance.
A single sample for a later leg is rejected at apply time
(`forecast_timeline_insufficient`), as are excessive gaps
(`forecast_gap_too_large`) and uncovered windows (`forecast_coverage_gap`).

Forecast expiry: if a leg's recalculated ETA moves more than 6 h beyond its
last sample, the planner does not reuse the last value. That leg is marked
`forecastCoverage: "out_of_range"` with no wind and no recommendation, the plan
is flagged `forecastCoverage: "partial"` with a warning naming the leg, and the
onboard API/UI surface the reason. The last valid plan remains in the durable
history, current observed conditions can still be displayed, recording and
local navigation continue, and no future-leg weather is invented.

## Output, snapshot persistence and delayed upload

Each calculation persists an onboard snapshot containing: source `onboard`,
generated time, Race Pack id/revision/digest, rule-set version, tracking/course
identity, observation window and quality, position, active/current leg,
completed leg count, recommendations for all remaining legs with the expected
condition and time used per leg, deterministic confidence/rationale, and
estimated finish/remaining duration.

The latest snapshot and a bounded queue of unpublished snapshots are persisted
under `<plugin data>/onboard-plans/<deviceId>/state.json` using the same atomic
write convention.

Snapshots publish to the existing events topic with
`kind: "race_plan_snapshot"` and retain pack/rule/source timestamps so Wake
Logger can distinguish historical onboard evidence from a current cloud
calculation. Publication is restart safe (durable queue), idempotent (each
snapshot has a stable identity and a published flag), bounded (five per status
cycle) and ordered by generation sequence. Nothing is sent while
`uploadMode === "local_only"`; the queue is flushed when Live tracking returns.

## API and onboard webapp

- `GET /plugins/signalk-wakelogger/race-plan` reports `calculationAuthority`
  (`cloud`/`onboard`), pack availability/currentness (pack id, revision,
  digest, generated/applied times, validity, applicability), last local
  calculation time, the current reason no calculation is available, the
  observation summary and the latest snapshot.
- `POST /plugins/signalk-wakelogger/race-plan/recalculate` requests an explicit
  onboard recalculation (only effective while authority is onboard).

The onboard Race panel shows the authority, Race Pack readiness, the
current/next leg recommendation and all remaining leg recommendations with the
expected wind/time, confidence, stale/insufficient-observation warnings and the
Race Pack status. When Live tracking is on it labels authority as
`Wake Logger` and any retained onboard plan as historical. Turning Live
tracking off without a valid pack is not blocked: recording continues and the
panel warns that onboarding recalculation is unavailable until a Race Pack has
previously synchronised.

## Offline guarantee

Once a Race Pack has been ACKed the plugin needs no internet, forecast, HTTP or
AI access to calculate. Automated tests prove: the pack loads after a store
restart, the five-minute observation window builds from local Signal K data,
the deterministic calculation runs from the persisted pack, the onboard
service recalculates on subsequent cadence ticks, and `local_only` produces no
outbound Wake Logger transport or pairing traffic.

## Failure modes

- Incomplete, corrupt, oversized, wrongly digested or identity-mismatched packs
  are rejected with a bounded error code and never replace the applied pack.
- A stale revision cannot roll the applied pack back.
- A pack that does not match the selected course is preserved but marked not
  applicable, so no recommendations are produced against the wrong course.
- Missing true-wind, STW or heel instruments degrade cleanly to derived wind or
  null fields; missing optional instruments never crash the planner.
- A crash between pack file write and metadata replacement leaves the previous
  pack usable.
- Snapshots queued during `local_only` are not lost and upload after authority
  returns to `automatic`.

## Rule-set version and parity

The pack carries `ruleSetVersion`; every plan and snapshot records the
rule-set version and pack id/revision/digest it was calculated from. Only
`race_plan_dynamic_v1` is accepted; unknown or incompatible rule sets are
rejected with `unsupported_rule_set` and the previously applied pack is kept.
The ported physics and selection functions are checked against frozen cloud
outputs (`test/fixtures/sail-physics.json`, 216 cases) and the planner is
deterministic for identical inputs (`test/unit/onboard-plan.test.ts`).

Parity with the cloud `race_plan_preview_v1` temporal algorithm is **not
claimed**. The onboard temporal rule (nearest own-leg forecast sample to the
recalculated leg midpoint ETA) is frozen separately as
`race_plan_dynamic_v1`. Cross-repo golden-fixture parity between the cloud
implementation and `race_plan_dynamic_v1` is pending an authoritative fixture
produced by the Wake Logger `wakelogger` repository. Snapshot publication lets
Wake Logger compare onboard and cloud calculations for the same window and tune
the shared rule set.

## Racing constraint

Some races prohibit transmitting or receiving data while racing. The plugin
already has the compliance control: with **live tracking off** (`local_only`)
the transport is stopped and nothing is transmitted or received. The onboard
features therefore must work from data downloaded before the switch goes off.
Mark-detection events and sail-plan snapshots queue in the existing outbox and
upload after the race.

## 1. Mark auto-detection

### Decision

Auto-detection is the preferred behaviour whenever the plugin holds the active
course for the day (desired course revision current and the native route owned
by Wake Logger). The crew can still override at any time.

### Modes

- **Auto** (default with an active course): detection advances the active route
  point through the same native API the manual controls use.
- **Suggest** (fallback): detection raises an accept/dismiss prompt. Used when a
  detection is below the confidence threshold, when another app owns the active
  route, or when the crew turns Auto off.
- **Off**: detection still records evidence; nothing is proposed or advanced.

Manual **Advance point** / **Set point** always win. An advance has a short undo
window. The plugin never advances backwards and never skips a point silently.

### Detection geometry

- Consider only the currently active point (plus gate alternatives), never a
  global nearest-mark search. This is required for marks used twice
  (out-and-back) and multi-lap routes.
- **Rounding**: crossing of the line perpendicular to the approach course (or
  the turn bisector) through the mark, interpolated between consecutive fixes,
  plus closest approach inside a capture radius and increasing departure
  distance. Crossing direction must match the expected leg direction, including
  reversed routes.
- **Start / finish**: line crossings with direction. Default to a line through
  the point perpendicular to the adjacent leg until the course document carries
  explicit line endpoints. Start crossings are recorded even when Auto is off.
- **Gates**: advance when either gate mark is passed according to its rounding
  side; grouping comes from the course document.

### Guardrails (initial, tunable from the cloud profile)

- Minimum SOG about 1 kn; reject fixes with poor accuracy.
- Capture radius about 50-100 m (scaled by fix accuracy, capped for short legs).
- Require several consecutive fixes or crossing plus departure beyond the
  radius; COG should turn toward the next leg.
- One advance per point per passage; hysteresis after advancing; rate limit.
- Persist the last processed index and dedupe on
  `(revision, pointIndex, type, time)` so restarts and replays cannot re-fire.

### Evidence

Every detection (auto, suggested or dismissed) publishes an event with course
revision, point index, type, interpolated crossing time, confidence and the
geometry used. The cloud compares these with its own analysis to tune
thresholds and to score start/finish times.

### Course document additions (cloud to plugin)

- Rounding side per mark: `port | starboard | either`.
- Gate grouping and mark kind (start, mark, gate, finish).
- Optional start/finish line endpoints; fallback remains a perpendicular line.
- Detection rule-set version.

The cloud's `ai_race_structure.py` already derives a relevant-side hint; that
work becomes part of the synced course metadata rather than a new cloud rule.

## 2. Onboard sail plan

### Decision

Run the **same deterministic calculation Wake Logger performs**, ported to the
plugin, every 15 minutes. Not the AI Sailing Captain. Inputs are downloaded
before the race; observations come from the vessel's own instruments.

### Race pack (pre-race download)

While online (for example while the course syncs), the cloud sends everything
the calculation needs:

- Course and route points, including rounding sides and mark kinds.
- Sail inventory and scenarios (the same `sails` input the cloud preview uses).
- Plan payload: start time, race configuration.
- `leg_forecasts`: hourly forecast timeline covering the race window with a
  configurable margin (default start minus 3 h to start plus 12 h).
- `forecast_snapshot` metadata (provider run, fetch time).
- `polar_summary`: the compact empirical polar summary.
- Rule-set version so cloud and plugin calculations can be compared.

The pack is versioned and stored in the plugin data directory. It must be
refreshed on every online course sync so an unexpected race start still has a
current pack.

### Cadence and observations

- Recalculate every 15 minutes while under way and a valid pack exists.
- Observed conditions are **5-minute instrument averages** (TWS, TWD, heading,
  SOG; heel/STW when available), plus current position, leg progress and ETA
  from Signal K's native course values.
- Update the plan for **all remaining legs**; the next leg is highlighted.

### Output

Per remaining leg: recommended sails and settings, expected conditions for the
leg's estimated time window, confidence and a short deterministic rationale,
with the generation timestamp and the pack/rule versions used. Stored locally
and served to the webapp through a read-only plugin route.

### Sharing after the race

Each generated plan snapshot publishes to the cloud as evidence once upload is
allowed again. The cloud compares it with its own recalculation for the same
window; discrepancies tune the shared rule set.

## Data flow and topics

- Downlink Race Pack: retained `.../race-pack/manifest` plus retained
  `.../race-pack/chunk/{index}` (see the wire protocol above). The existing
  `course` message cap (64 KiB) is too small for a weather timeline, so packs
  are chunked with a digest.
- Uplink ACK: retained `.../race-pack-ack`.
- Detections upload as `kind: 'race'` events; onboard plan snapshots upload as
  `kind: 'race_plan_snapshot'` events. The existing durable outbox and events
  machinery covers ordering, durability and deferred upload.
- The separator between the small `course` document (64 KiB limit, revision
  ACK, native route activation) and the `race-pack` document (weather, sails,
  polars, deterministic planning inputs) is preserved; the pack is never
  stuffed into the course document.
- Onboard calculation needs no inbound traffic at race time.

## Porting and parity

Cloud sources ported: the deterministic preview assembly and sail selection
(`build_race_plan_preview` equivalent) plus `classify_point_of_sail`,
polar-summary consumption and the remaining-course recalculation inputs from
`race_live_recalculation`. Cloud historical polar analysis is not ported: the
plugin consumes the `polar_summary` supplied in the pack. Parity is checked
with frozen fixtures (`test/fixtures/sail-physics.json`) and the planner is
deterministic for identical inputs. The rule-set version travels with the pack.

## Non-goals

- No AI or cloud calls during onboard calculation.
- No autopilot or vessel control.
- No RRS rules engine, scoring or OCS judgement onboard.
- No second navigation engine: course metrics stay with Signal K's native
  course values.
- No `upload_only` mode and no separate post-race upload workflow.

## Rollout phases

1. Race pack assembly and sync, including course rounding-side metadata. **Cloud
   side owned by the `wakelogger` repository; plugin receiver, store and ACK
   implemented here.**
2. Deterministic calculation port with golden-fixture parity tests.
   **Implemented.**
3. Onboard 15-minute scheduler, 5-minute averages, webapp display.
   **Implemented.**
4. Mark detection engine with Auto preference, evidence events and undo.
   **Implemented.**
5. Calibration: compare onboard plans and detections with cloud analysis and
   tune thresholds. **Ongoing; onboard snapshots publish as evidence when Live
   tracking resumes.**