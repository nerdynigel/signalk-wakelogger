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
