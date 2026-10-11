# ETA validity — THE-882 source/local checkpoint

Repository `nerdynigel/signalk-wakelogger`, workspace
`4de0cc0f-95fe-4135-ad51-b3e73b77de8b`, linked `.worktrees/THE-884`,
branch `release/2026-w42`, [draft PR #22](https://github.com/nerdynigel/signalk-wakelogger/pull/22).
Starting pin: `0e8ef2d7419a5cd63ef28149b0be0f4db962eac6`.
The commit containing this report is the tested source; full delivered SHA and
remote read-back are recorded in the issue implementation document.

## Discovery attribution and confirmed cause

Independent Verification discovery, 11 October 2026, issue document
`eta-discovery`, revision `68f3af35-55b8-47ab-99d9-bbe43b63b1f3`:
actual pinned cached waypoint code divides remaining NM by any positive
closing VMG. At (0,0), target (0,1/60), 0.01 kn yields 100.067 h;
5 kn nearly perpendicular (COG 0.001 degrees) yields February 2028.
24-hour-old GPS still emits ETA; epsilon speed throws RangeError. Native
negative VMG plus a 3-day TTG passes through. Injected now is bypassed by
Date.now; the page hides the arrival date. These are deterministic synthetic
source defects, not evidence of which surface or inputs caused Nigel's incident.
Pre-fix 43 service + 22 planner tests passed but did not prove these boundaries.
Detailed original discovery remains in Paperclip with the original attribution.

## Implemented contract

`webapp/course-progress.mjs` validates individual position, SOG and COG source
times, and every required native calculation source time. Freshness <=30 s,
input skew <=10 s, future tolerance <=5 s. Missing envelopes cannot claim fresh
ETA. Closing VMG must exceed 0.1 kn, TTG must be finite/nonnegative and <=24 h.
Native VMG cannot exceed SOG by more than 0.1 kn; TTG versus distance/VMG tolerance
is max(5 s, 1%) plus 1 microsecond for SI conversion rounding; ETA versus now+TTG
tolerance is 35 s. Past/invalid native dates are unavailable. Native values are
validated rather than recomputed. Cached ETA uses injected now; overflow cannot
throw. Distance/bearing/VMG retain their independent presentation contracts.

The v1 navigation tree supplies source envelopes from `navigation.course.calcValues`
when present. The v2 calculation endpoint alone provides scalar values and cannot
prove freshness. Upstream path documented by the
[Signal K course provider](https://github.com/SignalK/course-provider-plugin).
No route activation/control writes or protocol changes. ETA/TTG display — with
an availability reason; arrivals on another local day include calendar date.
Forecast algorithms and valid multi-day forecasts are unaffected.

## Executed validation

Node binary `/home/nigel/.nvm/versions/node/v24.21.0/bin/node` (N below).
Commands from the linked worktree; PATH prepended with its bin directory.

- `N --test test/webapp/services.test.mjs test/webapp/eta.test.mjs`: 73 passed
  (43 existing + 30 new). Normal 1.000674 nm / 5 kn gives 720.485 s.
  Stationary/drift/mid-tack/away/epsilon unavailable; recovery and injected-day
  shift pass. Inclusive 0.1 kn exclusion, 24h/freshness/skew/future boundaries,
  every required native timestamp, bad motion, negative/native inconsistency,
  epoch units, date overflow and stale-update recovery are executed.
- `N node_modules/vitest/vitest.mjs run test/unit/dynamic-golden.test.ts
  test/unit/onboard-plan.test.ts test/integration/onboard-race-plan.test.ts`:
  22 passed; forecast model compatibility preserved.
- `N scripts/build-webapp.mjs`; `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright
  N node_modules/@playwright/test/cli.js test --config test/webapp/playwright.config.mjs
  -g 'ETA native'`: 1 passed at 1280x800. Actual plugin page with disposable
  timestamped native/cached REST fixtures: normal, 3-day TTG rejection, date
  rollover, stale sensor, tiny speed, recovery/reload; zero navigation writes.
- `N node_modules/eslint/bin/eslint.js src test scripts --max-warnings=0`,
  `N scripts/check-public-repo.mjs`, `git diff --check`: exit 0.
- `WAKELOGGER_DOCKER_PROJECT=signalk-wakelogger-eta-882 N
  scripts/test-signalk-docker.mjs`: exit 0, packaged Signal K 2.31.1. Served
  course-progress.mjs equals source bytes. Actual bundled N2K REST inputs
  under source clock give cached TTG 27.197239071461613 s and ETA
  2014-08-15T19:00:30.746Z; stale SOG rejects and resumption restores identical
  ETA. Native wall-clock ETA/TTG are null with Fresh navigation inputs unavailable.
  Normal bundled 2014 replay does not establish fresh physical-native positive
  ETA. Existing native route/index, TLS tracking OFF/restart, outage/SIGKILL/
  restart and 10-sample recovery gates pass. Disposable stack/volumes removed.

Initial regression fixtures wrongly put the 24h boundary below the speed floor
and used an SI tolerance without floating point allowance; corrected fixtures
and 1 microsecond tolerance pass. No failing check is counted as passing.

## Acceptance limits and rollback

Original acceptance remains OPEN: no race-day surface/timestamp/deployed identity
or input capture; no physical current-vessel positive native proof; no frozen
independent acceptance or owner-Go Openclaw run. Browser native data are fixtures;
bundled 2014 replay is source-clock proof, not current telemetry. Cloud live ETA
is deliberately unavailable because it lacks individual sensor timestamps; see
web PR #81 / docs/evidence/eta-source.md. Software retains any missing
implementation proof; independent Verification is an additional gate.
Chief owns review and final disposition. No promotion, production mutation,
Openclaw switch, merge, npm publication or paid CI. Rollback: revert this scoped
commit on the release branch; no data migration.


## Frozen QA and correction publication — 11 October 2026

Verification's original attributed report and runnable reproduction, previously
published on review/THE-882-eta-evidence at
`c6d171363f5df198beb53b6e8999eda8db8dda37`, are integrated unchanged as
[eta-independent-review.md](eta-independent-review.md) and
[eta-order-repro.mjs](eta-order-repro.mjs). They record historical changes-requested
results at plugin49285dd76499428c4676ce7e7a98ed576530eff8 and
web74454ddc9c38addfa66307cd554b29f3baeb1c4b; the reproduction targets those old
helper/page semantics, not the corrected timestamp-based helper API.
Their historical failing finding is not a verdict on the new correction.

Website correction delivered to nerdynigel/wakelogger release/2026-w42-web,
`d51aedef2fe376e8b6d1d6e757924cfb2aaa83ce`, existing draft PR81.
`git push origin release/2026-w42-web` exit0 and independent `git ls-remote origin
refs/heads/release/2026-w42-web` exact match. Only pre-existing untracked
frontend/node_modules remains. Plugin runtime source remains identical to
49285dd76499428c4676ce7e7a98ed576530eff8; this plugin commit only integrates
review and correction evidence. Prior pinned plugin/native/API proof is reused,
not rerun or promoted to physical-current/Openclaw proof.

Corrected page carries authoritative preceding finish, rejects overlapping
starts, preserves unknown/recovery/order across gaps, and shares the timeline
between table, weather notes, detail/print cards and race summary. Valid long
forecasts remain supported. Website executed18 timing tests (six new
regressions), fresh Next webpack build and1200x900/390x844 fixture page checks:
PASS, no page errors/control writes. Initial browser assertion used the wrong
formatting; corrected assertion passed. Original web committed diff-check PASS
is superseded by QA exit2; correction's committed diff from
e6b5e32b4a46df8eace5dd4f7370d5f28e90b1d2 passes exit0. Plugin documentation
incremental diff-check passes; copied evidence bytes verified against the source
review commit. Exact commands and changed-behaviour acceptance map are in the
website eta-source.md at the delivered SHA.

Independent recheck required. Original acceptance remains OPEN: current physical
native positive proof stays Software-owned, incident attribution unknown,
owner-Go Openclaw NOT RUN. No candidate promotion or production/release action.
Rollback: revert website correction; revert this evidence-only plugin commit
only to remove integration. No migration. Chief retains acceptance holds.
