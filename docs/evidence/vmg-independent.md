# Independent VMG source checkpoint review — THE-879

2026-10-11, Verification & Release Engineer, reporting to Chief.
Decision: approve the source/local checkpoint only. Original Openclaw acceptance
remains open; this is no release, merge, deployment or candidate authorization.

## Identity and scope

- Plugin: https://github.com/nerdynigel/signalk-wakelogger, frozen release/2026-w42
  `e0f460ac394287559d4bf9eb25767e71615d7045`, source
  `5639759734303bbe24beac152dce4b7f07cc6c41`, draft PR #22.
- Web: https://github.com/nerdynigel/wakelogger, frozen release/2026-w42-web
  `12edced8caef6590ca05baa129f8820f3bee06e5`, source
  `ced9af9abc02f62b2b647c60bf5a8a7b8eafb5b8`, draft PR #81.
- Both `git ls-remote origin refs/heads/<release branch>` results match the
  frozen full SHAs. Runtime/test diffs between source and evidence heads are
  empty. Plugin tree was clean; web has only the pre-existing untracked
  frontend/node_modules dependency link. No implementation edits made.
- Evidence publication uses a separate linked plugin worktree and branch
  `review/THE-879-vmg`; release branches remain at their frozen revisions.

## Independently executed validation

Node `/home/nigel/.nvm/versions/node/v24.21.0/bin/node`, v24.21.0.
Commands below ran against the frozen worktrees, all exit 0:

1. Plugin `node --test test/webapp/services.test.mjs`: 39 PASS. Includes direct
   angle precedence, ground/water isolation, missing/invalid/future/stale/skew,
   zero, signs, fallback and recovery.
2. Plugin `npm run build:webapp`, then
   `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright ./node_modules/.bin/playwright test --config test/webapp/playwright.config.mjs --grep 'VMG tiles|TWA tiles|stale measurement|Finish explains'`:
   4 PASS, Chromium 1280x800. PATH included the Node directory above.
   Actual built page with routed REST fixtures proves water-only VMG, visible
   missing/stale states, downwind, recovery and Race strip; TWA and Finish
   regressions pass. Test-managed server/browser terminated normally.
3. Web `node --test frontend/tests/live-telemetry-wind.test.mjs`: 7 PASS.
   Ground COG/heading distinction, zero/downwind/direct priority, lost inputs,
   reference changes and recovery across raw/responsive/steady modes.
4. Independent stdin Node assertion harness imported plugin instrumentReadings
   and evaluated angles -360 through +360 degrees at 15-degree intervals and
   speeds [0, 0.1, 2, 9] m/s. For each case asserted both availability and
   absolute error <1e-9 against independently specified water
   `speed * 1.9438444924406 * cos(TWA)` and ground
   `speed * 1.9438444924406 * cos(TWD - COG)`; COG=0.71 and heading=-1.23
   radians. 392 projection assertions PASS.

Initial shell checks could not find bare node/python; explicit installed Node
and python3 worked. No packages or host configuration were changed.

## Findings and limitations

Reviewed the actual scoped commits and source reports. Plugin baseline logic
required absolute wind direction, omitted unavailable VMG tiles, and Race only
selected ground VMG. Corrected webapp/instruments.mjs uses water TWA with STW,
ground TWD with SOG/COG or ground TWA plus true heading, and labels a usable
water fallback. Native waypoint VMG remains separately labelled. The independent
projection and browser checks support this reproduced code cause, not attribution
to historical vessel measurements.

Web VMG was already present: api/app/services/signalk_live.py:619 computes ground
projection; frontend/app/lib/liveTelemetry.js consumes finite API VMG or derives
it. LiveTelemetryReadout.js:205 now labels reference and sign. No website water
VMG protocol expansion occurred. Existing report-level timestamps do not provide
plugin-style per-field freshness; no freshness certification is made here.

NOT RUN independently: web rendered browser checks, DB-backed API integration,
full builds/CI, native Signal K replay/crash recovery, authenticated web browser,
and Openclaw actual inputs/live/negative/recovery. Executor reports distinguish
their local routed, DB/HTTP and native replay checks; those are reviewed evidence,
not independent reruns. Scoped source review found no blocking defect, but these
passes cannot satisfy the original Openclaw gate or establish historical cause.

Chief owns final-stage reconciliation and serial scheduling. Software retains
actual Openclaw implementation proof after candidate freeze and owner Go;
Reliability owns any authorized environment switch. Preserve all original
criteria and sibling holds. Rollback remains reviewed source-commit reverts and
plugin asset rebuild, without migration or persisted-state rewrite.
