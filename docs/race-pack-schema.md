# Race Pack schema and onboard snapshot contract (v1)

This is the exact contract between the Wake Logger cloud/broker side and the
`signalk-wakelogger` plugin. The MQTT envelope (manifest/chunk/ACK) is in
`docs/onboard-race-guidance.md`; this document freezes the canonical Race Pack
content, the supported rule set, the size constants and the delayed snapshot
event.

A machine-readable representative example lives in
`test/fixtures/race-pack.example.json` and is parsed by
`test/unit/race-pack-fixture.test.ts`.

## Supported rule set

Only `race_plan_dynamic_v1` is accepted. Any other `ruleSetVersion` is rejected
with `unsupported_rule_set` before the pack is applied, and the previously
applied pack is preserved. The name is location-neutral because the identical
deterministic rules run in two places: Wake Logger cloud (Live tracking ON) and
the Signal K vessel (Live tracking OFF). The cloud implementation must
implement the identical rules and advertise this exact identifier.

`race_plan_dynamic_v1` rule (identical in
`src/race/dynamic.ts` and the cloud `api/app/services/race_plan_dynamic.py`
mirror):

1. **Active leg geometry.** The current/next leg starts at the latest valid
   vessel position (`current vessel position -> active point`), not the previous
   mark. Future legs stay `mark -> mark`; completed legs are historical. If no
   valid position is available the active-race calculation reports
   `no_current_position` and never fabricates one.
2. **Initial speed estimate.** Per remaining leg, choose a deterministic initial
   boat-speed estimate: usable polar first, then `vesselPerformance`, then the
   documented generic hull-speed fallback. Derive a provisional duration and
   midpoint ETA from it.
3. **Bounded midpoint refinement (max 3 iterations).** Select, from **that
   leg's own** `forecast.legs[].samples[]`, the sample nearest the provisional
   midpoint (ties break to the earlier sample). Recompute wind geometry, boat
   speed and estimated SOG, then the duration and midpoint. Stop as soon as the
   selected sample is stable; the loop is bounded at
   `MAX_MIDPOINT_ITERATIONS = 3` and never borrows another leg's series.
4. **Current in SOG.** For forecast-driven legs, add the along-leg component of
   the sample's `current_velocity_kn` / `current_direction_deg` (direction of
   set, degrees true) to the boat speed and clamp to
   `MIN_ESTIMATED_SOG_KNOTS = 0.5`. SOG drives duration and ETA; TWA is not
   adjusted for current.
5. **Observed current leg.** Once the five-minute observation window is ready
   the active leg uses observed wind but retains the forecast current/wave at
   the calculated time. Future legs are always forecast-driven.
6. **Coverage / out of range.** If the nearest sample for a leg is more than
   `maxForecastExtrapolationMs` (6 h) from the calculated time, that leg is
   reported `out_of_range` with no wind and no recommendation.
7. **Reverse courses.** Reversed native course order is not supported by v1:
   onboard calculation fails closed with `reverse_course_unsupported` rather
   than calculating the course forwards.

The earlier one-pass midpoint/assumed-speed timing is removed. Cross-repo parity
is proven by the shared golden scenario in
`test/fixtures/dynamic_golden.json` (byte-identical with the cloud
`api/tests/fixtures/race_pack/dynamic_golden.json`) and the harness
`wakelogger/scripts/race-plan-parity.py`. The cloud publishes the same
authoritative remaining timing from a prepared Race Pack.

## Forecast coverage contract

A pack is only fully usable if **every leg that can become a future remaining
leg** carries a real time series:

- each `forecast.legs[]` entry has `>= minForecastSamplesPerLeg` (2) samples,
  strictly time-ordered (`forecast_timeline_insufficient` otherwise);
- consecutive samples are no more than `maxForecastGapMs` (6 h) apart
  (`forecast_gap_too_large` otherwise);
- the declared coverage window is covered by every leg. The window is
  `forecast.coverage { from, until }` when present, otherwise `validFrom` /
  `validUntil` are used as the coverage window. Each leg's first sample must be
  within `maxForecastGapMs` of `from` and its last sample within
  `maxForecastGapMs` of `until` (`forecast_coverage_gap` otherwise);
- total samples across all legs `<= maxForecastSamplesTotal`.

A single sample for a later leg is rejected. A stale single value is never
silently reused, and conditions are never extrapolated arbitrarily far beyond
the last sample.

## Size constants (exact)

| Constant | Value | Meaning |
| --- | --- | --- |
| `maxManifestBytes` | `8192` | complete manifest MQTT payload |
| `maxChunkMessageBytes` | `65536` | complete serialised chunk MQTT JSON message |
| `maxChunkChars` | `49152` | base64 `data` fragment length in characters (divisible by 4) |
| `maxChunks` | `64` | maximum chunks in one pack |
| `maxCompressedBytes` | `262144` | gzip bytes after base64 decode |
| `maxUncompressedBytes` | `1048576` | canonical JSON bytes after gunzip |
| `maxPendingPacks` | `4` | partially received packs buffered |
| `maxCoursePoints` | `256` | course points |
| `maxSails` | `128` | sail inventory entries |
| `minForecastSamplesPerLeg` | `2` | minimum time samples per leg |
| `maxForecastGapMs` | `21600000` | maximum gap between consecutive samples (6 h) |
| `maxForecastSamplesPerLeg` | `2048` | samples per leg |
| `maxForecastSamplesTotal` | `32768` | samples across all legs |
| `maxForecastExtrapolationMs` | `21600000` | maximum distance from the recalculated time to the nearest sample (6 h) |

Measured realistic stress pack (`makeStressPack`, 11 legs, 96 hourly samples
per leg = 1056 samples, 30 sails, 80 polar buckets): **209,917 B uncompressed /
17,116 B gzip / 22,824 base64 chars (1 chunk required)**. The
compressed/uncompressed bounds above give roughly 4-15x headroom over that
measurement.

Chunk assembly is always: concatenate `data` fragments in `index` order, then
base64-decode once, then gunzip. Do not base64-encode independent compressed
byte ranges.

## Canonical Race Pack content

All timestamps are ISO-8601 UTC strings. Unknown extra fields are preserved
(forward compatible), but fields used by calculation are validated strictly.

```jsonc
{
  "v": 1,
  "kind": "race_pack",
  "packId": "pack-42-1",              // ^[A-Za-z0-9._:-]{1,128}$
  "revision": 4,                       // integer >= 1, monotonic per device
  "racePlanId": 42,                    // integer or null
  "generatedAt": "2026-09-17T01:00:00Z",
  "validFrom": "2020-01-01T00:00:00Z", // ISO or null
  "validUntil": "2035-01-01T00:00:00Z",// ISO or null
  "ruleSetVersion": "race_plan_dynamic_v1",
  "course": {
    "courseId": "race-42",             // must match the selected course
    "racePlanId": 42,                  // optional, cross-checked
    "name": "Saturday bay race",
    "points": [
      {
        "id": "start",                 // optional stable id, <=120 chars
        "name": "Race start",          // required, <=255 chars
        "latitude": -27.4,             // -90..90
        "longitude": 153.17,           // -180..180
        "kind": "start",               // start|mark|gate|finish (optional)
        "rounding": "either",          // port|starboard|either (optional)
        "gate": { "group": "g1", "role": "port" },   // optional, or null
        "line": { "port": { "latitude": -27.401, "longitude": 153.169 },
                  "starboard": { "latitude": -27.399, "longitude": 153.171 } } // optional, or null
      }
    ]
  },
  "sails": [
    {
      "id": 1,
      "sail_name": "Doyle main",
      "sail_type": "Mainsail",
      "availability_status": "Available",
      "is_available": true,
      "archived_at": null,
      "max_aws_knots": null, "min_awa_deg": null, "max_awa_deg": null,
      "min_twa_deg": 0, "max_twa_deg": 180, "min_tws_knots": 0, "max_tws_knots": 25,
      "crew_required": 1,
      "reef_1_tws_knots": null, "reef_2_tws_knots": null, "reef_3_tws_knots": null
    }
  ],
  "raceHeadsail": { "sail_id": 3, "sail_name": "No. 3 jib" }, // optional, or null
  "payload": {
    "startTime": "2026-09-17T02:00:00Z",
    "availableCrewCount": 3,
    "jibChangesAllowed": false
  },
  "forecast": {
    "snapshot": {                        // provider/run metadata, forward compatible
      "provider": "example-model",
      "runAt": "2026-09-16T18:00:00Z",
      "fetchedAt": "2026-09-16T18:30:00Z"
    },
    "coverage": {                        // optional; defaults to validFrom/validUntil
      "from": "2026-09-17T00:00:00Z",
      "until": "2026-09-18T00:00:00Z"
    },
    "legs": [
      {
        "sequence": 1,                   // 1-based; leg index into course.points
        "latitude": -27.395,             // optional representative location
        "longitude": 153.17,
        "samples": [                     // required, time-strictly-increasing, >=2, gaps <= 6 h
          { "time": "2026-09-17T02:00:00Z", "twd_deg": 45, "tws_knots": 14, "gust_knots": 18,
            "wave_height_m": 0.6, "wave_direction_deg": 60,
            "current_velocity_kn": 0.4, "current_direction_deg": 200 },
          { "time": "2026-09-17T03:00:00Z", "twd_deg": 60, "tws_knots": 13, "gust_knots": 17 }
        ]
      }
    ]
  },
  "polarSummary": { "eligible": false }  // optional; consumes the supplied summary
}
```

Validation rules:

- `forecast.legs` must contain exactly `course.points.length - 1` entries and
  cover `sequence` `1..points.length-1` exactly once (`forecast_leg_coverage`).
- Every leg needs at least two samples (`forecast_timeline_insufficient`) that
  are strictly increasing in `time`, with no gap larger than 6 h
  (`forecast_gap_too_large`).
- Each leg's first/last sample must cover the declared window
  (`forecast.coverage`, else `validFrom`/`validUntil`) within a 6 h tolerance
  (`forecast_coverage_gap`).
- `tws_knots` 0..200, `twd_deg` 0..360, gust 0..250, wave height 0..100,
  wave/current direction 0..360, current speed 0..50.
- `ruleSetVersion` must be supported; `packId` must match the manifest.

## Delayed onboard snapshot event

Emitted on the existing `wakelogger/v1/devices/{deviceId}/events` topic (QoS 1,
not retained) only when `uploadMode === "automatic"`. The transport adds
`deviceId`; the snapshot supplies `v` and `kind`.

```json
{
  "v": 1,
  "deviceId": "dev_example",
  "kind": "race_plan_snapshot",
  "id": "pack-42-1:4:1758074700000",
  "generatedAt": 1758074700000,
  "source": "onboard",
  "packId": "pack-42-1",
  "packRevision": 4,
  "packSha256": "5f2c...64-hex...",
  "ruleSetVersion": "race_plan_dynamic_v1",
  "tracking": { "courseId": "race-42", "racePlanId": 42, "activeIndex": 1, "totalPoints": 3, "reverse": false },
  "observations": {
    "twsKnots": 13.9, "twdDeg": 45, "headingDeg": 10, "cogDeg": 10,
    "sogKnots": 6, "stwKnots": null, "heelDeg": null, "awsKnots": null, "awaDeg": null,
    "sampleCount": 12, "windowSeconds": 300, "windSource": "true"
  },
  "position": { "latitude": -27.395, "longitude": 153.18 },
  "activeLegSequence": 1,
  "completedLegCount": 0,
  "estimatedFinishAt": "2026-09-17T03:10:00.000Z",
  "remainingDurationSeconds": 3300,
  "legCount": 2,
  "plan": {
    "v": 1,
    "generatedAt": "2026-09-17T02:05:00.000Z",
    "packId": "pack-42-1",
    "packRevision": 4,
    "ruleSetVersion": "race_plan_dynamic_v1",
    "courseId": "race-42",
    "racePlanId": 42,
    "activeLegSequence": 1,
    "completedLegCount": 0,
    "estimatedFinishAt": "2026-09-17T03:10:00.000Z",
    "remainingDurationSeconds": 3300,
    "observed": { "twsKnots": 13.9, "twdDeg": 45, "headingDeg": 10, "cogDeg": 10, "sogKnots": 6, "stwKnots": null, "heelDeg": null, "awsKnots": null, "awaDeg": null, "sampleCount": 12, "windowSeconds": 300, "windSource": "true" },
    "legs": [
      {
        "sequence": 1,
        "from": { "name": "Race start", "latitude": -27.4, "longitude": 153.17 },
        "to": { "name": "Eastern mark", "latitude": -27.39, "longitude": 153.17 },
        "distanceNm": 0.6,
        "bearingDeg": 90,
        "twaDeg": 45,
        "pointOfSail": "close-hauled",
        "windSide": "starboard",
        "estimatedSpeedKnots": 3.5,
        "polarSpeedKnots": null,
        "conditions": { "source": "observed", "twsKnots": 13.9, "twdDeg": 45, "gustKnots": 13.9, "waveHeightM": null, "waveDirectionDeg": null, "currentVelocityKn": null, "currentDirectionDeg": null, "sampleTime": null },
        "plan": { "mainsail_configuration": "full_main", "summary": "Full main + No. 3 jib", "confidence": "high", "race_headsail": { "sail_id": 3, "sail_name": "No. 3 jib" }, "jib_changes_allowed": false }
      }
    ]
  }
}
```

Idempotency: `id` is stable for a given `(packId, revision, generatedAt)` and
the durable queue marks each snapshot published exactly once. Ordering follows
the generation sequence. At most five snapshots are drained per status cycle,
and nothing is published while authority is `onboard`/`local_only`.
