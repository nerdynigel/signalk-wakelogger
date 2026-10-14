# Continuous course progress — THE-881 plugin source checkpoint

Repository `nerdynigel/signalk-wakelogger`; registered workspace
`4de0cc0f-95fe-4135-ad51-b3e73b77de8b`, linked `.worktrees/THE-884`,
branch `release/2026-w42`, [draft PR #22](https://github.com/nerdynigel/signalk-wakelogger/pull/22).
Starting remote `e0f460ac394287559d4bf9eb25767e71615d7045`.
Tested source **05f3aa0ae045ddb146bbf2e8b3e0b4b91763c855**.

## Reproduction, root cause and fix

At the starting revision, importing the committed `webapp/course-progress.mjs`
and evaluating positions .25 and .75 longitude on a fixed equatorial leg
returned **[50, 50]**. The route was Start (0,0), Mark (0,1), Finish (0,3),
active waypoint 1. `raceProgress.pointPercent` was simply rounded waypoint
index / point count. It described the next route point, not vessel progress;
it even showed 100% when the finish became the next point.

The existing instrument loop polls position every 2 seconds and course polling
renders every 3 seconds. There was no missing position subscription.
`webapp/course-progress.mjs:courseProgressPercent` now uses cumulative fixed
geometric route length and the vessel's along-track projection on the active
leg. Projection is clamped between the leg endpoints: overshooting cannot
advance a waypoint or count future legs. Route reversal uses the displayed
native ordering; zero/invalid geometry and missing positions remain unavailable.
Known invalid/future/stale timestamps suppress the percentage using the existing
30-second instrument boundary. Timestamp-free legacy coordinates retain their
existing compatibility; this does not certify their freshness. An optional clock
argument enables deterministic source-clock verification and defaults to wall
clock in the app. The label now explicitly says course progress by distance.
Native distance/bearing/VMG/ETA remains authoritative and unchanged.

No control writes, persistence changes, timer changes or new protocol fields.
The next-leg command and manual rounding authority remain unchanged.

## Executed validation

Node `/home/nigel/.nvm/versions/node/v24.21.0/bin/node`; PATH includes that directory.
Commands ran from this linked worktree at the tested source bytes.

- `node --test test/webapp/services.test.mjs`: **41 passed**. New position tests
  prove 8% → 25% on fixed leg 1, unequal-leg distance weighting, repeated fixes,
  backward/overshoot clamping, reverse order, invalid/missing/recovery, known
  stale/future timestamps and no-course. Existing TWA/VMG/tracking/Finish tests pass.
- `npm run build`, `npm run typecheck`, `npm run lint`, `npm run check:public`,
  `git diff --check`: **exit 0**.
- `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright node
  node_modules/@playwright/test/cli.js test --config test/webapp/playwright.config.mjs
  --grep 'course progress changes|advances native|rounding'`: **3 passed**.
  Actual onboard page with routed Signal K fixtures shows 0% → 25% at unchanged
  mark, makes no navigation writes, rejects stale GPS, recovers, reloads and
  advances manually. Existing explicit point selection and manual rounding pass.
  An initial harness failure clicked the hidden Course control; selecting its
  tab corrected the test. Final rerun after clock injection passed.
- `WAKELOGGER_DOCKER_PROJECT=signalk-wakelogger-course-881 node
  scripts/test-signalk-docker.mjs`: **exit 0**, packaged Signal K **2.31.1**.
  The served `course-progress.mjs` exactly matches the tested source. A disposable
  course is built around real bundled N2K positions and native route geometry.
  Native REST inputs produce **25% → 26%**, with **waypoint index 1 unchanged**;
  manual nextPoint then produces **index 2**. These samples use the bundled
  **2014 replay clock**, not current-clock vessel inputs; the same timestamped
  inputs produce unavailable percentage at wall clock. Native tracking choice,
  course conflict/revision/duplicate/reversal/restart, TWA/VMG and broker outage
  plus SIGKILL/recovery gates also pass. All containers, volumes and network removed.

## Preserved prior evidence

`docs/evidence/vmg-independent.md` is byte-for-byte identical to the already
published report in **9188130ba8b4ec244fc3bf543f18bd731eaa4afb**. Its frozen-source
meaning is preserved: it is prior independent VMG evidence, not approval of this
course-progress source. `docs/evidence/vmg-source.md` and earlier tracking,
TWA and Finish reports remain unchanged. No duplicate tests solely for this doc.

## Acceptance, remaining proof and rollback

| Requirement | Executed evidence / remaining |
| --- | --- |
| Continuous on plugin and website | Plugin actual-page fixtures and native packaged replay above; website `docs/evidence/course-progress-source.md` supplies live DB ingestion/owner/public HTTP and actual public page fixtures. |
| No leg activation regression | 3 browser flows plus native pointIndex/nextPoint, manual authority, route conflict and restart gates pass. |
| Missing/invalid/stale/recovery/repeated/finished/no-course | Focused geometry/freshness tests and stale/recovery/reload browser flow. At the last active leg, actual arrival can show 100%; activating that leg alone no longer shows 100%. |
| Test-env Openclaw | **Pending final candidate freeze and owner Go.** Software retains actual-input/live/negative/recovery proof across both surfaces; current-clock real vessel input and authenticated owner browser remain to be observed. Independent Verification and final Chief gates are additional, not waived. |

Chief → independent Verification → Chief saved review stages are the next path.
This is a published source/evidence checkpoint, not full original acceptance or
permission to promote a candidate. Original tracking/TWA/Finish/VMG final holds
remain. No production replay, deployment/environment switch, merge, npm
publication or paid CI. Rollback: reviewed revert of the source commit above;
no database/data correction. Reverting it also removes the copied independent
VMG document from integration; its original published branch stays intact.
