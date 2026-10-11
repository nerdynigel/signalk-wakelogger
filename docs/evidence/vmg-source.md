# Wind VMG source checkpoint — THE-879

Repository `nerdynigel/signalk-wakelogger`, registered plugin workspace
`4de0cc0f-95fe-4135-ad51-b3e73b77de8b`, linked `.worktrees/THE-884`, branch
`release/2026-w42`, [draft PR #22](https://github.com/nerdynigel/signalk-wakelogger/pull/22).
Starting remote head: `6198b4778293fcf397f6c66ac71cd069c49dc27b`.
Tested source: `5639759734303bbe24beac152dce4b7f07cc6c41`.

## Reproduction and contract

Executing baseline `webapp/instruments.mjs` from `git show` with fresh STW
2 m/s and `environment.wind.angleTrueWater = pi/3` returned no water VMG tile
and an unavailable Race VMG. Correct water projection is 1.9438444924406 kn.
These are observed synthetic inputs, not the owner's incident measurements.

Code root causes in `instrumentReadings` and `liveNavigationStrip`:
- VMG required absolute `directionTrue` (or derived TWD), ignoring direct TWA.
- Unavailable VMG tiles were omitted entirely, so missing data looked like a
  missing instrument. Race selected only ground VMG even when water was usable.
- One derived absolute direction could feed both velocity bases.

The onboard page polls local Signal K navigation/environment REST branches in
`webapp/app.mjs`; it does not depend on cloud telemetry subscriptions, a selected
course, a Race Pack or recording. Operational status is not an instrument API.
Protocol v1 and `src/signalk/paths.ts` remain unchanged: apparent wind and motion
are carried to the website, which computes ground wind VMG.

Wind VMG is positive upwind, negative downwind, in knots. Signal K speeds enter
in m/s and angles in radians. The ground projection is
`SOG * cos(TWD - COG)`; with ground TWA and true heading it is
`SOG * cos(heading + TWAground - COG)`. Heading never substitutes for COG.
Water projection is `STW * cos(TWAwater)`; measured water TWA needs neither GPS
nor an absolute heading. Fresh direct water TWA wins over absolute direction;
ground prefers a usable compatible TWD, then ground TWA plus true heading.
Each TWA retains the existing direct-over-derived precedence. An unqualified
direct `directionTrue` retains the established ground convention; it cannot
certify water VMG without water TWA or an explicitly water-derived direction.
A derived direction can only feed its own basis. No direct
`performance.velocityMadeGood` is consumed: that producer's published definition
mentions apparent angle, whereas this UI explicitly projects true wind.
[Signal K keys](https://signalk.org/specification/1.7.0/doc/vesselsBranch.html).

All required inputs must have valid nonfuture timestamps, be fresh within
30 seconds and within 10 seconds of one another. The oldest input bounds VMG.
Missing/nonfinite/negative speed, stale/skewed inputs and unknown true heading
when required yield unavailable; no cached VMG is relabelled fresh. Both tiles
remain visible with diagnostics. Race selects available ground then available
water VMG and labels the selected basis. The existing native course calculation
is separate waypoint VMG; its label now says **VMG to waypoint**.

## Executed checks

Commands use Node `/home/nigel/.nvm/versions/node/v24.21.0/bin/node` and its npm.
- `node --test test/webapp/services.test.mjs`: **39 passed**, final source.
  New regressions cover ground COG versus heading, water-only inputs, zero,
  both signs/wrap, direct-angle priority, incompatible direction, visible
  fallback, missing/invalid/unknown/future/stale/skew, oldest input and recovery.
- `npm run build:webapp`, `npm run build`, `npm run lint`, `npm run typecheck`,
  `npm run check:public`, `git diff --check`: exit 0. Final water reference
  restriction is plain JS; final build:webapp and browser checks reran after it.
- `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright npx playwright test
  --config test/webapp/playwright.config.mjs --grep 'VMG tiles|TWA tiles|stale measurement|Finish explains'`:
  **4 passed** on final source, 1280x800 Chromium. Actual built page/assets with
  routed REST fixtures: water VMG 1.9 kn, missing unavailable, downwind -3.9 kn,
  stale unavailable, recovery and reload; no page errors. TWA/stale/Finish
  regressions also pass. Routed inputs are not native or Openclaw observations.
- `npx vitest run test/unit/wind-derivation-parity.test.ts
  test/unit/observation-golden.test.ts test/unit/observation-readiness.test.ts
  test/integration/tracking-controls.test.ts`: **40 passed**, including tracking
  choice and Finish failure/recovery. Those source modules were unchanged.

Initial test-writing failures (missing test import and an incorrectly fresh
COG in a water-fallback fixture) were corrected; final regression run is green.
Commit identity was absent; per-command Paperclip identity was used without
changing global configuration. No credential files or generated public assets
were committed.

## Acceptance and next owner

| Original requirement | Evidence / residual |
| --- | --- |
| Root cause with code and observed inputs | Baseline reproduction plus native replay below. Actual historical incident/Openclaw inputs remain uninspected; data-source attribution is unconfirmed. |
| Correct VMG visible on both surfaces | Plugin service/browser proof above; website ground VMG already present, clarified label and API/browser proof in web `docs/evidence/vmg-source.md`. Water VMG on website is out of scope by current protocol, which carries no STW/water TWA; no protocol expansion authorised. |
| Openclaw plus targeted tests | Local checks pass. Openclaw actual-input, changed-page positive/negative/recovery proof NOT RUN; final owner-Go W42 gate stays open. Software owns implementation proof; Verification independently checks frozen candidates and reports to Chief. |

Native Chief → Verification → Chief source review is required. This checkpoint
is not final acceptance, merge/deployment approval or candidate promotion.
Rollback: reviewed revert of source `5639759734303bbe24beac152dce4b7f07cc6c41`,
then rebuild public assets. No migration or persisted-state change. Existing
tracking/TWA/Finish source and evidence are preserved.

## Final native packaged replay at the tested source

`WAKELOGGER_DOCKER_PROJECT=signalk-wakelogger-vmg-879-final npm run test:docker`:
**exit 0**, Signal K 2.31.1. Packaged served instruments exactly matched source
bytes. Real disposable Signal K REST inputs at bundled replay clock
`2014-08-15T19:00:00.892Z`: SOG **3.47 m/s**, COG **3.4296 rad**, derived TWD
**268.0851928444906°**; ground VMG **2.1309303689587367 kn**, equal to the
independent SOG/COG projection assertion. Missing heading for apparent-wind
conversion was rejected; the 2014 samples were unavailable at wall clock;
restoring the same inputs at replay clock recovered availability. This is
native HTTP/replay proof, not a current-clock positive vessel stream or Openclaw.

Default tracking OFF, explicit choice/restarts, local upload, broker outage plus
SIGKILL/recovery (ACK 10 → 21, 11 recovered samples), current state before backlog,
drained queue and course conflict/progress/restart gates all passed. Containers,
volumes and network were removed. A first native run also passed but preceded
final rejection of unqualified water bearings; final run above supersedes it.
Native replay source timestamps explain stale display at current wall clock;
freshness policy was not weakened. Local browser positives remain routed
fixtures, as distinguished above.
