# True wind source checkpoint — THE-878

Repository: `nerdynigel/signalk-wakelogger`, branch `release/2026-w42`.
Source: `c2998f3b67a481947f591689cc19322cf30c329b`, based on remote-verified
`ee536dbaa1f1695772ac588fc20c6159230bfba5`. 11 October 2026.
This is a plugin source checkpoint; original web/Openclaw acceptance stays open.

## Reproduced defects and correction

An isolated execution of the starting revision's `webapp/instruments.mjs`
(using `git show` and the unchanged wind helper in run-owned scratch) returned:

```json
{"waterInstrumentAvailable":true,"raceTwaAvailable":false,"derivedTwsAvailable":true,"derivedTwaAvailable":false}
```

The water-only input was fresh `environment.wind.angleTrueWater = -pi/6`.
The apparent-only input used fresh true heading/COG 0, SOG 5 knots,
AWS 10 knots and AWA +30 degrees. This reproduces two code defects without
claiming these were the owner's actual vessel inputs:

- `liveNavigationStrip` selected the always-existing ground entry by nullish
  fallback, masking available water TWA. It now selects a fresh ground or water
  entry before retaining unavailable diagnostics.
- `instrumentReadings` derived TWS/TWD but left TWA direct-only. It now derives
  each TWA independently from apparent wind and that basis's motion vector,
  subtracting true heading from the wind-from bearing. COG is never substituted
  for bow heading. Fresh direct angles win. Fresh direct TWS or TWD is preserved
  when only its counterpart needs derivation.
- The instrument TWS reader ignored `environment.wind.speedOverGround`.
  Fresh water `speedTrue` wins; fresh ground `speedOverGround` is a direct
  fallback, with basis/reference metadata. SI m/s converts to knots.

Signal K paths `angleTrueGround`/`angleTrueWater` use radians, negative to port;
`directionTrue` uses radians relative to true north; `speedTrue` is water wind
and `speedOverGround` is ground wind in m/s. Reference:
[Signal K vessel keys](https://signalk.org/specification/1.5.0/doc/vesselsBranch.html).
TWA displays signed degrees, positive starboard. Ground derivation uses SOG/COG;
water uses STW/true heading. Relative AWA additionally needs true heading;
absolute `directionApparent` may supply apparent bearing but TWA still needs
true heading. Inputs must be fresh (30 seconds), within 10 seconds of each other,
with known nonfuture timestamps. The oldest input bounds derived freshness.
Calm/no-direction vectors remain unavailable. Magnetic-only heading cannot derive
TWA. Direct angles need neither GPS nor course/pack/cloud activation.

The onboard UI polls local `/signalk/v1/api/vessels/self/navigation` and
`/environment` (`webapp/app.mjs`), independently of the telemetry subscription.
It renders Instruments tiles and the Race live-navigation strip. Telemetry
`src/signalk/paths.ts`/`normaliser.ts` and protocol v1 intentionally carry
apparent wind only; status contains operational counters, not sensor values.
This change does not publish derived wind into Signal K or change protocol v1.
No VMG/course-progress/sibling implementation changed.

## Web consumer inspection and required routed continuation

Read-only GitHub inspection of `nerdynigel/wakelogger` draft PR #81 source
`a806f2887ae45fa4632633cec87cfeefc5285269` (`release/2026-w42-web`):

- `frontend/app/lib/liveTelemetry.js:normalizeLiveState` maps AWS/AWA/TWS/TWD,
  but no TWA. `smoothLiveTelemetry` returns raw samples unchanged in raw mode;
  responsive/steady modes derive TWS/TWD/VMG and spread derived values over the
  smoothed state. Its `deriveTrueWind` accepts heading without checking true vs
  magnetic and substitutes COG for missing heading.
- `frontend/app/components/LiveTelemetryReadout.js` renders AWS/AWA/TWS/TWD
  and VMG, but no TWA. Thus website TWA is missing in code, not proved by design.
  Raw mode can show unavailable true wind because producer protocol v1 sends
  apparent wind only, while other modes derive values.
- `frontend/app/components/RouteMapPanel.js:3833` does render a chart row
  labelled "TW Angle", but `chartplotterTwAngleText` at line 5721 formats
  `liveWindDirectionDeg` (absolute true-north TWD). It does not subtract heading.
  Its arrow uses TWD + 180. Thus a purported angle is actually direction; this
  must be corrected or clearly labelled direction in the routed web task.
- `api/app/schemas/signalk_live.py` permits TWS/TWD fields but no TWA.

Commands: `gh pr view 81 --repo nerdynigel/wakelogger --json headRefName,headRefOid,url`,
`gh api repos/nerdynigel/wakelogger/git/trees/<SHA>?recursive=1`, and
`gh api repos/nerdynigel/wakelogger/contents/<path>?ref=<SHA>` (decoded content).
No second-repository edit or browser acceptance was performed.

Chief must route this SAME outcome into registered web workspace
`4c588ef5-e0ec-475c-a7f6-f4501c9f4d3e` and existing draft PR #81 for Software.
The web correction needs explicit true-heading/reference and freshness guards,
correct bow-relative chart TWA instead of TWD under "TW Angle",
TWA normalization/rendering and raw/smoothed positive/negative tests. This
inspection neither waives website acceptance nor authorizes downstream use.

## Executed validation at unchanged delivered implementation

- `npm run build:webapp`: passed.
- `node --test test/webapp/services.test.mjs`: 36 passed. New TWA regression
  covers both signs and bases, zero direct values, direct precedence, direct
  ground TWS conversion, water-only and stale-ground strip selection, oldest
  input timestamp, unknown/future/stale/skewed/missing/nonfinite inputs,
  magnetic heading rejection, missing STW and calm water wind.
- `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright npx playwright test
  --config test/webapp/playwright.config.mjs --grep 'TWA tiles|losing GPS|stale measurement'`:
  3 passed at final implementation. Desktop 1280x800, local disposable HTTP
  asset server with mocked Signal K REST responses. TWA tiles and Race strip
  show +54 degrees; switching to water-only shows -30 and survives reload.
  Earlier broader run also passed standalone/default and hanging-course tests
  (5 total), before the final direct ground-TWS fallback.
- `npm run lint`: passed after final source/harness edits.
- `npx vitest run test/unit/wind-derivation-parity.test.ts
  test/unit/observation-golden.test.ts test/unit/observation-readiness.test.ts`:
  20 passed (unchanged shared wind helper/planner; browser derivation parity).
- `npm run typecheck`, `npm run check:public`, `git diff --check`: passed.

## Native disposable replay observation

The first packaged run was deliberately stopped (143) after a final ground-TWS
source change; its stack was cleaned up and its result superseded. Two subsequent
native freshness attempts timed out, correctly: the bundled `--sample-n2k-data`
replay retains August 2014 source timestamps. This was diagnosed by real REST
reads from the disposable server, not by changing freshness policy.

One sanitized observation at wall clock `2026-10-11T09:42:40.670Z`:

| Native path | Value (SI) | Source timestamp |
| --- | --- | --- |
| navigation.headingTrue | 3.5622 rad | 2014-08-15T19:00:13.905Z |
| navigation.courseOverGroundTrue | 3.4488 rad | 2014-08-15T19:00:13.775Z |
| navigation.speedOverGround | 3.56 m/s | 2014-08-15T19:00:14.280Z |
| environment.wind.speedApparent | 6.74 m/s | 2014-08-15T19:00:13.994Z |
| environment.wind.angleApparent | 0.8905 rad | 2014-08-15T19:00:13.994Z |

The wind branch contained AWS/AWA, with no direct TWA/TWS/TWD. The positive
native replay check therefore evaluates the unchanged instrument module at the
maximum required source timestamp. Its negative checks independently require
missing-heading rejection at that replay clock and stale rejection at wall
clock. The served packaged module must exactly match the tested source bytes.
This is native HTTP/replay evidence, not a current vessel stream or Openclaw.
Generated source/public instrument SHA-256 is
`56d33e9929cdcc4756d86f6a9e70081e64eab1847a409724f8cea99ee915abd4`.

Native replay check passed with source clock `2014-08-15T19:00:00.892Z`,
`source: derived`, `basis: ground`, TWA `68.98235903652949` degrees. The Race
strip was available at that clock, missing heading was rejected, wall-clock
staleness was rejected, and packaged asset equality passed.

Final command: `WAKELOGGER_DOCKER_PROJECT=signalk-wakelogger-e2e-4141036
WAKELOGGER_DOCKER_SKIP_BUILD=1 npm run test:docker`: exit 0 on Signal K 2.31.1.
The reused image was built from the final unchanged instrument source during the
first completed freshness attempt; only the host harness clock handling changed.
Existing regression gates passed: safe initial OFF, confirmed intent persistence,
local recording/upload, broker outage + SIGKILL/restart recovery (ACK 10 to 21;
11 recovered samples), current state before backlog, drained queue and native
course/progress/conflict/restart gates. All project containers, volumes and the
network were removed. Both prior timeout stacks were also removed.
No current-clock positive native stream was exercised: the positive native
measurement proof uses the explicitly recorded replay clock. Software retains
actual-input/live proof with the owner-authorized Openclaw gate.

## Rollback and residual acceptance

Restore `webapp/instruments.mjs` and affected regression tests/harness from
baseline `ee536dbaa1f1695772ac588fc20c6159230bfba5` on a rollback branch, or
revert the implementation and subsequent harness/evidence commits together; no data migration, configuration or persisted
tracking choice changed. Generated `public` assets must be rebuilt from `webapp`.
No deployment, Openclaw environment switch, merge, npm publication or paid CI.

Chief source review and workspace routing, independent Verification, website
implementation and owner-authorized Openclaw proof remain required. No observed
Openclaw data was available in this run, so the owner's precise data-source or
incident cause remains unconfirmed. Disposable and mocked inputs do not prove
Openclaw or production behavior.

## Acceptance reconciliation

| Original requirement | Source evidence | Remaining owner/action |
| --- | --- | --- |
| Exact paths/units/sign/reference and root cause | Baseline reproduction, Signal K definitions, instrument reader/strip and telemetry trace above | Software after Chief routing: inspect actual Openclaw inputs; do not infer incident causation from fixtures |
| Plugin TWA/true wind visible and correct | 36 service tests and final 3 browser checks; independent ground/water vectors and freshness negatives | Independent Verification at frozen source |
| Web live TWA/true wind visible and correct | Exact PR #81 source inspection proves missing TWA and raw-mode gap | Chief routes Software to registered web workspace; implement and validate SAME outcome |
| Test environment Openclaw | Not run; no environment switch authorized in this slice | Chief routes owner-authorized final W42 proof after source freeze |
