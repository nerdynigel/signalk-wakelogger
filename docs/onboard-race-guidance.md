# Onboard race guidance: mark detection and sail plan

Design for two related onboard features. Both work fully on the boat; the cloud
remains authoritative for post-race review. No AI runs on the vessel.

## Implementation status (2026-09-16)

Mark detection is implemented in the plugin and the onboard app:

- `src/race/detection.ts` (engine), `src/race/progression-store.ts` (durable
  mode and evidence log), `src/race/progression-service.ts` (Auto/Suggest/Off).
- Plugin config `raceProgressionMode` (default `automatic`), runtime changes
  through `POST /plugins/signalk-wakelogger/progression/mode`, pending state via
  `GET /plugins/signalk-wakelogger/progression`, resolution through
  `POST /plugins/signalk-wakelogger/progression/resolve`.
- Detections and resolutions queue durably and upload as `kind: 'race'` events
  on the existing events topic whenever the transport is online.
- The onboard app applies **Auto** advances with Signal K's native
  `nextPoint` endpoint (the same call as the manual Advance button) and then
  resolves the detection as accepted.

Known constraint: Signal K publishes no plugin API to change the active route
point index. `app.activateRoute()` resets the native course start time, so the
plugin must not use it for advancement. Auto therefore requires the onboard app
to be open with a signed-in user; otherwise detections wait as pending until it
reconnects. Upstreaming a small point-index API would remove that requirement.

The race pack and onboard sail-plan calculation are not implemented yet; the
rest of this document is the agreed design for them.

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

- New downlink topic (for example `pack`) carrying the race pack. The existing
  `course` message cap (64 KiB) is too small for a weather timeline, so packs
  need chunking or per-section retained messages with a digest.
- New uplink events for detections and plan snapshots; the existing `events`
  and outbox machinery covers ordering, durability and deferred upload.
- Profile extension for detection thresholds and pack margins. Onboard
  calculation needs no inbound traffic at race time.

## Porting and parity

Cloud sources to port: `build_race_plan_preview` (race_plan_service),
`build_empirical_polar_analysis` (polar_analysis), `classify_point_of_sail`
(point_of_sail) and the remaining-course recalculation inputs in
`race_live_recalculation`. Port with golden fixtures: frozen pack inputs and
cloud outputs checked against the TypeScript implementation so both produce the
same plan for identical inputs. The rule-set version travels with the pack.

## Non-goals

- No AI or cloud calls during onboard calculation.
- No autopilot or vessel control.
- No RRS rules engine, scoring or OCS judgement onboard.
- No second navigation engine: course metrics stay with Signal K's native
  course values.

## Rollout phases

1. Race pack assembly and sync, including course rounding-side metadata.
2. Deterministic calculation port with golden-fixture parity tests.
3. Onboard 15-minute scheduler, 5-minute averages, webapp display.
4. Mark detection engine with Auto preference, evidence events and undo.
5. Calibration: compare onboard plans and detections with cloud analysis and
   tune thresholds.