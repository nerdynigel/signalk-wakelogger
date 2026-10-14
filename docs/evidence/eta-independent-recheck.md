# THE-882 independent correction recheck

11 October 2026. Verification & Release Engineer, directly to Chief.

**PASS for the bounded forecast-order correction. Original acceptance remains
OPEN; no release or candidate approval.** This report supersedes the ordering
and whitespace failures in eta-independent-review.md at the revised pins only.
The historical reproduction deliberately uses the old helper signature and
must not be interpreted as a current-source recheck.

## Frozen identity

- Website nerdynigel/wakelogger, release/2026-w42-web,
  d51aedef2fe376e8b6d1d6e757924cfb2aaa83ce, draft PR81 targeting master.
- Plugin nerdynigel/signalk-wakelogger, release/2026-w42,
  5cd50c0980aac5a6cf6ffae9364b2675206ad644, draft PR22 targeting main.
- Independently executed git ls-remote for both release branches and gh pr view
  81/22 --json url,headRefOid,baseRefName,isDraft: exit0, exact SHA matches.
- Registered plugin workspace 4de0cc0f-95fe-4135-ad51-b3e73b77de8b;
  registered web sibling 4c588ef5-e0ec-475c-a7f6-f4501c9f4d3e.
  Plugin .worktrees/THE-884 clean. Web wt-w42 has only pre-existing untracked
  frontend/node_modules. Tests/browser build use detached linked website
  .paperclip-runtime/wt-the-882-recheck at the exact pin, with existing dependency
  symlink; no release-source edits. No repository AGENTS.md tracked.
- racePlanTiming.js SHA256 independently computed:
  870983b04b5f3c3140e1ffc5267b22df77c643c456c57acd20449d9ae4167dca.

## Independently executed

N=/home/nigel/.nvm/versions/node/v24.21.0/bin/node (v24.21.0).
W=absolute path to detached website worktree. Commands below exit0 unless noted.

| Command/check | Result |
| --- | --- |
| N --test frontend/tests/race-plan-timing.test.mjs at revised web pin | PASS18 |
| N docs/evidence/eta-order-recheck.mjs W on evidence branch | PASS: exact explicit finish, overlap refusal, unknown propagation/recovery |
| From W/frontend, PATH includes Node bin; NEXT_TELEMETRY_DISABLED=1 N node_modules/next/dist/bin/next build --webpack | PASS fresh build |
| From W/frontend, N node_modules/next/dist/bin/next start -p3399; PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright N e2e/eta-mocked.cjs | PASS1200x900 and390x844 |
| Same server/browser path, N docs/evidence/eta-print-recheck.mjs W | PASS1200x900 and390x844, print/table/card/weather/overall consistency |
| Plugin git diff 49285dd76499428c4676ce7e7a98ed576530eff8 5cd50c0980aac5a6cf6ffae9364b2675206ad644 --check | PASS; three evidence files only |
| Web git diff e6b5e32b4a46df8eace5dd4f7370d5f28e90b1d2 d51aedef2fe376e8b6d1d6e757924cfb2aaa83ce --check | PASS; prior EOF failure corrected |

An initial build from W with the frontend directory argument completed but
reported missing Tailwind content configuration. It was superseded by the
frontend-cwd build above before browser validation. The print harness initially
failed its blanket no-write assertion on the shared layout analytics heartbeat.
All requests were intercepted; timing assertions passed. The harness now explicitly
permits only that intercepted heartbeat, matching the saved-plan fixture policy;
rerun passes with no control writes or page exceptions. No product fixes by QA.
Browser sessions closed and local server stopped after checks. Screenshots are
run-owned scratch artifacts; assertions and runnable harnesses are durable proof.

## Acceptance mapping

- Original failure: leg1 explicit Oct15 16:00 finish, despite 1nm/5kn duration,
  now gives leg2 start Oct15 16:00 and finish16:12. PASS actual source and pages.
- Leg2 explicit Oct12 start overlapping leg1 finish is refused; start/finish and
  following derived timing are unknown. PASS source and saved-plan pages.
- Equal/later explicit starts, gaps, invalid dates, reversed finish, unknown
  boundary preservation, explicit finish/start recovery: PASS18 regressions.
- Legitimate 100h/200h forecasts remain dated Oct15/Oct19. PASS desktop/mobile.
- Table/detail/overall summary share authoritative timeline; print cards/table
  and wind-change summary use Oct15, with overall100h12min. PASS browser.
- Reviewed RacePlanClient.js changed consumers: summarizeRacePlan,
  buildRaceWeatherSummary, RacePlanOverallSummary, RacePlanSnapshotView and
  RacePlanPrintView all use racePlanLegTimings; no remaining elapsed-duration
  scheduling in these paths. PASS source inspection.
- Unchanged plugin/API tests are reused from independent historical QA at plugin
  49285dd76499428c4676ce7e7a98ed576530eff8 and web
  74454ddc9c38addfa66307cd554b29f3baeb1c4b: 73 ETA/services,22 forecast,
  16 cloud/router and focused native browser. Plugin revised commit changes only
  evidence; website correction leaves API unchanged. These suites were NOT
  re-executed in this correction pass. Cloud ETA remains authorised unavailable
  fallback, not positive cloud telemetry proof.

## Residuals and disposition

Current physical-native positive remains Software-owned and NOT RUN. Race-day
observed input/deployed identity remains unknown; this correction does not establish
incident attribution. Openclaw NOT RUN pending frozen owner Go. Fixtures are not
current real telemetry. No production access/mutation, Openclaw switch, deployment,
merge, npm, candidate promotion or paid CI.

Native QA stage may advance to final Chief reconciliation only. Chief owns routing
remaining proof, evidence integration into existing draft PRs and preserving the
original acceptance/serial holds. No new discovery PR. Rollback remains scoped
revert of ETA implementation commits; no schema/data migration. Evidence branch
review/THE-882-eta-evidence contains only QA documentation and harnesses.


---

## Resumed heartbeat independent confirmation

# THE-882 independent correction recheck

11 October 2026. Verification reporting directly to Chief. PASS for the focused
source/local correction stage only; original acceptance remains OPEN.

## Frozen identities

Plugin nerdynigel/signalk-wakelogger release/2026-w42
`5cd50c0980aac5a6cf6ffae9364b2675206ad644`, draft PR22.
Website nerdynigel/wakelogger release/2026-w42-web
`d51aedef2fe376e8b6d1d6e757924cfb2aaa83ce`, draft PR81.
Independent git ls-remote and gh pr view checks matched both full heads.
Plugin root and release worktree clean. Website registered linked wt-w42
contained only its pre-existing untracked frontend/node_modules symlink.
No release source edits. Evidence branch review/THE-882-eta-evidence.

## Commands and actual results

N=/home/nigel/.nvm/versions/node/v24.21.0/bin/node (24.21.0).
Website W=registered sibling wakelogger/.paperclip-runtime/wt-w42.
Commands from W/frontend unless specified.

- `N --test tests/race-plan-timing.test.mjs`: PASS18, fail0, exit0.
  First invocation incorrectly included frontend/ from frontend cwd and failed
  file lookup; corrected command above is the executed suite.
- `N node_modules/next/dist/bin/next build`: FAIL exit1, Turbopack rejects
  pre-existing node_modules symlink outside filesystem root. No dependency edit.
- `N node_modules/next/dist/bin/next build --webpack`: PASS exit0, fresh build
  from frozen source; stale Browserslist warning. Default build is not certified.
- `N docs/evidence/eta-order-recheck.mjs W` from evidence branch: PASS exit0.
  Actual helper SHA256 870983b04b5f3c3140e1ffc5267b22df77c643c456c57acd20449d9ae4167dca.
  Former failure now gives leg2 start Oct15 16:00Z, finish16:12Z;
  explicit Oct12 overlap yields null start/finish and prevents derived propagation.
  Unknown boundary remains unknown, ordered Oct16 explicit recovery resumes.
- Bounded foreground Python orchestration started `N node_modules/next/dist/bin/next
  start -p3399`, waited for HTTP readiness, ran both browser harnesses and terminated
  the server in finally. Heartbeat currentExecutionWorkspace was null; no configured
  runtime service available. No persistent background server.
- `N e2e/eta-mocked.cjs`: PASS1200x900 and390x844, exit0. Unknown duration,
  authoritative finish, rejected overlap, table/card/summary consistency,
  legitimate 100h forecasts with dates, normal recovery and unavailable cloud
  ETA reason. No page exceptions or unexpected control writes.
- `N docs/evidence/eta-print-recheck.mjs W`: PASS both same viewports, exit0.
  Actual print page table/detail/weather/overall summary agree on Oct15 next leg
  and100h12min overall. Disposable injected print fixture; analytics intercepted;
  no page exceptions or control writes. Screenshots in run-owned scratch only.
- Plugin `git diff 49285dd..5cd50c --check`: PASS exit0 (evidence-only increment).
- Website `git diff e6b5e32..d51aedef --check`: PASS exit0; old EOF failure corrected.

## Decision and preserved gates

Approve the focused corrected source/local stage for final Chief reconciliation.
The old ordering and whitespace failures are superseded at these pins. Page
source routes table, detail, print, weather and overall summary through the shared
racePlanLegTimings timeline. Browser checks use fresh webpack output, not a prior
build. Prior independent plugin73/service, forecast22 and cloud/API16 results at
49285dd/74454dd remain reusable: plugin increment is evidence-only and correction
scope changes forecast timeline, not cloud/API logic. They were not rerun here.

This does not establish physical-current native positive telemetry. That missing
implementation proof remains Software-owned, NOT RUN. Race-day inputs/deployed
identity remain unknown; confirmed source reproductions do not attribute the
incident. Owner-Go frozen Openclaw acceptance remains NOT RUN. Cloud live ETA is
intentionally unavailable absent individual sensor provenance. Chief retains
original acceptance, release freeze and serial discovery holds. No candidate
promotion, production mutation, Openclaw switch, merge, npm or paid CI.
Rollback: scoped revert of ETA implementation commits; no data migration.
