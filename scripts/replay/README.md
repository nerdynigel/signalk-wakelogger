# Real sailing replay

Replay the original Yacht Devices messages from production trip 48 into an
isolated Signal K server, the real Wake Logger plugin, and the development
website. Production is a read-only source. No response mocks are used by the
end-to-end acceptance run.

The clip is **28 June 2026, 13:06–13:26 Australia/Brisbane**, with 30 seconds of
preceding sensor initialization. It lies inside the saved SAGS race window,
averages about 6.3 knots and includes upwind/downwind sailing and a turn near
Lockyer Light. No engine RPM messages are recorded: sailing is inferred from
the saved race window and sensor/track evidence, not proven engine-off status.

## Local setup

This operator tool targets an existing local development installation: API
`127.0.0.1:8010`, website `:3000`, its HTTPS pairing endpoint and the development
MQTT broker advertised by that API. The account bootstrap checks
the configured development hostname before creating a short-lived local session for
the existing test admin account. It enables that account's test Race Analytics
flag if needed, preserving the previous overrides in the private data directory.
It does not reset passwords or use production account/device credentials.

The dedicated vessel is **Replay — SAGS 2026-06-28**. Its route is a private copy
of the saved course, initialized to Lockyer Light. All records and device
pairings belong to that dedicated vessel. Original production uploads and
normal test vessels remain unchanged.

The replay server uses **port 3003** because another test stack already owns
3002. Set `WAKELOGGER_REPLAY_PORT` when provisioning and controlling a deployment
on another port. The normal `signalk-dev` server on 3001 is not changed.

Run commands from this repository, using `sg docker -c '…'` on this host when
Docker group membership requires it. Default private data directory:
`$HOME/.local/share/wakelogger-replay/trip-48`; override with
`WAKELOGGER_REPLAY_DATA`.

Create a private `environment.json` in that directory before provisioning:

```json
{
  "apiOrigin": "http://127.0.0.1:8010",
  "expectedServiceOrigin": "https://your-development-service.example",
  "publicWebOrigin": "https://your-development-service.example",
  "signalKOrigin": "http://TEST_HOST:3003",
  "pairingUrl": "https://your-development-service.example/backend/v1/signalk/pair",
  "ownerUserId": 1,
  "ownerDisplayName": "Your test admin"
}
```

Use the real development origins and local account identity. The helper rejects
production destinations and refuses to mint a local session when the running
API's configured public origin differs from the selected development origin.
Keep this configuration and token files private; do not commit them.

1. `sh scripts/replay/fetch-source.sh PRIVATE_DATA_DIRECTORY` downloads only the
   selected archive and course using the existing production SSH alias.
2. `sh scripts/replay/prepare.sh PRIVATE_DATA_DIRECTORY /path/to/wakelogger`
   validates the DAT framing/UTC anchors and converts the selected messages.
   It uses the locally installed Wake Logger API image and Signal K image.
3. Copy the tested plugin tarball into `PRIVATE_DATA_DIRECTORY/wakelogger-feature.tgz`.
   This installation uses feature build `94138c0`, locally packaged as beta.12.
4. `node scripts/replay/replay.mjs provision` creates the test vessel/course/plan,
   a fresh Signal K data directory and a new test-only device pairing. It pins
   the image ID currently installed on `signalk-dev` and installs the local
   plugin tarball and receive-only replay provider. Playback starts paused.

Provisioning prints the vessel, onboard and controls URLs. Open
`http://TEST_HOST:3003/plugins/wakelogger-real-trip-replay/controls`, select
**Start test**, then **Start and enable Live tracking**. This confirms the normal
tracking choice and starts the feed on the same page. Cancelling or a failed
tracking save leaves the feed stopped. The on-page confirmation also works in
embedded views without browser-native modal or form permissions.

`publicWebOrigin` selects the website; `signalKOrigin` selects the separate
Signal K server. Configure both when the website uses HTTPS. The Open test
website link retains the test vessel and Live tab.

## Playback and recorded data

The page shows Start/Resume and Pause with the current playback and tracking
state. Command-line controls also support Stop:

```
node scripts/replay/replay.mjs start
node scripts/replay/replay.mjs pause
node scripts/replay/replay.mjs resume
node scripts/replay/replay.mjs stop
node scripts/replay/replay.mjs status
```

Playback is **1× and one pass**. Sensor values, sources, references and original
intervals are retained. UTC envelope timestamps and embedded navigation clocks
are shifted to the current run; original timestamps and source ZIP checksums
remain in the artifacts. Pausing emits nothing. Resume rebases future events
without filling the gap; a scheduler delay over one second pauses instead of
bursting through queued observations.

The recording contains magnetic heading and measured magnetic variation. True
heading is derived from their sum only while both are within ten seconds of
the source event. Derived source metadata and the preparation report describe
that calculation. COG is never substituted for heading. Wind is derived by the
normal plugin from the recorded apparent wind and motion. The test plan uses the normal current-time forecast provider for planning.
That forecast is separate from the original recorded live wind observations;
it is not a historical weather forecast for the sailing date.

Old chartplotter route/waypoint output and other-vessel AIS are excluded. The
saved Wake Logger course supplies navigation intent. At the recorded turn
(source time about **13:16:21 AEST**), use the normal website waypoint-advance
control, or `node scripts/replay/replay.mjs advance`, to select Green Island East
Racing Buoy. The helper checks both current indices before acting: the cloud's
existing approach-plane rule can already advance at that turn, whereas the
onboard route remains under its own control. The helper uses the supported
native point control as well; no automatic cross-device synchronization is
claimed. The track passes about 180 metres from the stored Lockyer mark;
tolerances are not enlarged.

At EOF, the feed ends and readings naturally become stale. Select **Finish
trip** in the onboard app to close the recording. `reset` refuses an unfinished
trip or pending upload/cloud confirmation, then creates clean per-run Signal K storage and a fresh device pairing.
Prior run data/evidence are retained; no normal vessel or production data are
deleted. Start test on the controls page confirms Live tracking again.
Command-line Start requires a previously confirmed Live tracking choice.

## Validation and artifacts

```
node --test scripts/replay/engine.test.mjs
```

DAT framing/clock tests run in the local API image:

```
docker run --rm --entrypoint python \
  -v /path/to/wakelogger/api/app/services/ydvr_decoder.py:/decoder.py:ro \
  -v "$PWD/scripts/replay:/tool:ro" \
  wakelogger-api:latest /tool/test_prepare_frames.py
```

`acceptance.mjs` runs in the cached Playwright container with host networking,
the repository at `/work`, its Node dependencies mounted at `/work/node_modules`,
and the private data directory at `/data`. It uses real API responses and real
wall-clock time, waits for normal trip qualification, checks both browsers,
pauses for 135 seconds, resumes, reloads, advances the mark and finishes the run.
Allow at least 23 minutes. Do not change the feed manually during acceptance.

Artifacts include DAT framing/anchor counts, any truncated source records
outside the selected interval, converted path/reference coverage, original and
rebased emission timestamps, native/cloud snapshots, screenshots and traces.
Personal DAT files, credentials and generated recordings belong outside Git.
See [the validation record](VALIDATION.md) for the real sailing run and limits.

`node scripts/replay/verify.mjs` checks the materialized cloud trip against the
actual emitted sensor values. The packet capture time is the position clock,
so independent wind/heading readings match exact original observations within
1.5 seconds of that clock, with only serialization/unit-conversion tolerances.
The result records the observed skew and error for each field.

## Isolated guidance validation

A separate private `environment.json` may set `containerName` (a dedicated
`wakelogger-…` name) and `vesselName`. Set `WAKELOGGER_REPLAY_PORT` before
provisioning a new data directory. These options create a separate test vessel,
route, run and Signal K container; do not point a new validation at an existing
recording's data directory. Immutable prepared source files may be copied into
the new private directory. They must resolve inside the container mount.

For an offline damping comparison, set `WAKELOGGER_REPLAY_DATA` and run
`node scripts/replay/benchmark-guidance.mjs /private/output/benchmark.json` after
building. It reports selected steady-window jitter, estimate visibility and
source-timestamp turn lag. It does not calibrate a vessel or invent unavailable
rudder, leeway or current observations.

Real acceptance records source, canonical native/cloud snapshots and each
browser's guidance publication timestamp. Compare angles at the same publication
timestamp, since local/cloud/browser polling runs at different rates. A bounded
retry handles transient GET transport failures; control writes are never retried
automatically. Interrupted runs retain their failure evidence before continuing
with `WAKELOGGER_REPLAY_CONTINUE=1`. No source events are skipped on resume.

The source comparison also reads the harness's checksummed file-outbox frames
without opening or repairing the store. Keep the full recording available and
use a non-decimated cloud trail. It validates every measured field against the
recorded raw sample and original emissions, honors magnetic/true heading
reference, and counts absent fields filled by the existing trip pipeline
separately. Filled fields are not treated as measured sensor evidence.
