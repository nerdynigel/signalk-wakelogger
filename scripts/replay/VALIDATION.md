# Real sailing replay validation — 24 October 2026

The original trip 48 Yacht Devices archive was read from production without
changing production data. The selected interval was 28 June 2026,
13:06–13:26 Australia/Brisbane, with 30 seconds of initialization.

The real feed emitted all **89,639 Signal K events**, spanning original UTC
03:05:30.373 through 03:25:59.999. It ran at 1× through Canboat mapping, an
isolated Signal K 2.31.1 server, the feature plugin build `94138c0`, paired MQTT
and the test API. The normal Signal K instance was not reconfigured.

The dedicated test trip is **535**, with **997 accepted samples**, zero rejected
or missing samples, and no dropped plugin queue entries. The cloud comparison
matched latitude/longitude exactly at all 997 points. Heading, COG and SOG
matched at all 997 points; apparent wind angle/speed matched at all 800 points
where recorded. Maximum numeric rounding error was below 0.0000005 in the
reported units, with sensor clock skew below 453 ms.

Actual browser checks covered movement qualification, heading displays on both
maps, a real 135-second pause and expiry, resumed freshness, page reload,
Green Island selection and explicit Finish. There were no browser page errors.
The first driver attempt assumed cloud progress could not already have
advanced. The cloud approach-plane rule had advanced near Lockyer, while the
native course used its own point control. The driver was corrected, and the
same stream resumed from its cursor. This run includes that extra operator
pause. It does not prove automatic cross-device waypoint synchronization.

Finish exposed starvation in the test API's recording worker: recorder status
retries refreshed `updated_at`, keeping the current finished recording behind
older incomplete history. The companion web branch orders work by the oldest
processing attempt, with unattempted work first. Its regression reproduces the
failure against the original ordering. Browser acceptance now requires cloud
readiness, not just local Finish text.

After the companion API fix was deployed, the normal worker processed the
existing recording and its paired device received **cloud state ready** for
trip 535. Upload and confirmation flags were false, with an empty queue and
997/997 samples acknowledged. The final source comparison still passed. No
recording state was manually edited or forced ready. Environmental enrichment
was separately pending when the core trip confirmation arrived.

Five replay scheduler/clock tests, five DAT framing/anchor tests and all 49
companion API recording tests passed in isolated validation containers.
Personal source files, emitted data, browser screenshots/traces, the initial
driver failure report and complete numeric comparison remain in private
per-run artifacts outside Git.

Limits: engine RPM was not recorded, so sailing is inferred from the saved
race window and telemetry. The original archive contains a truncated final
record well after this clip; preparation reports it and rejects truncation
inside the clip. True heading is explicitly derived from measured magnetic
heading and variation. The planner uses current test forecasts, while live
wind and motion come from the original recording.

## Stable guidance follow-up

The complete original 89,639-event source was replayed at 1× with source-clock
smoothing. Qualification, actual stale-data pause/recovery, reload, both mark
controls and quiet maps passed. The resulting recording contains 1,111 samples;
all were acknowledged and the cloud trip became ready with zero loss/rejection.
Ninety-nine canonical publications agree with both displayed headings. Measured
raw fields match checksummed recording frames and original emissions. Eighty-five
wind observations absent during pauses are explicitly distinguished from later
trip enrichment. No rudder/current/leeway correction is invented for this source.

A real reconnect exposed an abandoned MQTT callback that blocked backlog draining
while live samples continued. The connection-close cleanup and two regression
cases fix that failure. The same durable recording recovered without replaying
source messages. The initial failed Finish deadline is retained as evidence
alongside successful finalization. The final plugin unit suite passes 316 tests;
seven existing optional SQLite cases remain skipped without the native binding.
The complete onboard browser regression covers 50 cases. This is test validation,
not an npm/App Store release or a vessel calibration claim.
