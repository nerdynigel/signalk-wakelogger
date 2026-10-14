# Independent tracking verification — 11 October 2026

Reviewer: Verification & Release Engineer, THE-884, reporting directly to Chief.
Repository: https://github.com/nerdynigel/signalk-wakelogger
Candidate: `release/2026-w42`, `6dc7343f3591f82fa4acac0f1fabdf7d34e0921c`.
Draft PR: https://github.com/nerdynigel/signalk-wakelogger/pull/22

Candidate worktree was clean. `git ls-remote origin refs/heads/release/2026-w42`
and `gh pr view 22 --json url,headRefOid,isDraft` independently matched that SHA.
This evidence-only commit does not change the tested implementation.

## Executed checks

Node v24.21.0. Commands ran in the existing linked THE-884 worktree.
The shell initially lacked node/npm/npx on PATH (exit 127); the installed
`/home/nigel/.nvm/versions/node/v24.21.0/bin` was prepended for subsequent commands.
Dependencies were prepared with `npm ci --ignore-scripts --no-audit --no-fund`
and `npm rebuild better-sqlite3`, both exit 0. No host packages installed.

- `npm run build:webapp`: PASS, exit 0. Browser assets regenerated from candidate.
- `npx vitest run test/integration/tracking-controls.test.ts test/integration/local-recording.test.ts test/integration/onboard-race-plan.test.ts`:
  PASS, exit 0, 25/25 tests in 3 files (20 tracking, 1 local, 4 onboard), 26 seconds.
- `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright npx playwright test --config test/webapp/playwright.config.mjs --grep 'live switch|cancel in either|failed mode save|stale tracking'`:
  PASS, exit 0, 4/4 tests. Desktop 1280x800; mobile cancellation/keyboard 390x844.
- `git diff --check`: PASS, exit 0; tracked worktree still clean after tests.

## Criterion assessment

- Both-direction modal: PASS. Browser asserts current/target dialog text and
  confirmed request fields. Cancel in both directions leaves the state unchanged;
  keyboard Space cancellation makes no write. Save errors read back the actual
  paused state; stale confirmation makes one write and does not retry.
- Durable choice: PASS in isolated integration. Both ON and OFF survive plugin
  restart despite contradictory legacy settings. Browser reload retains ON;
  OFF remains established by the initial/reloaded mock state and integration.
- Fail-off: PASS for missing, malformed, unconfirmed, unsupported version,
  EISDIR unreadable, invalid mode, and null state. Failed choice persistence and
  interruption after rename restart OFF. Pending enable followed by OFF does
  not start obsolete transport.
- No silent enablement: source-reviewed all activeUploadMode assignments.
  Constructor/start initialize OFF; initialise restores only validated version-1
  confirmed choice and checks the pause guard. The authenticated tracking route
  rejects absent confirmation and stale expected mode, persists before assignment,
  and checks operation revision/generation. Race/course/reconnect paths do not
  assign ON; transmission/snapshot reconnect paths check active mode. Legacy
  settings cannot override the saved choice. This client confirmation contract
  does not prove a malicious authenticated API client displayed a dialog.
- Race/local regression: PASS; explicit ON, race authority and snapshot behavior,
  final retained OFF status and silence, and recording without MQTT after restart.
- README correction: reviewed against schema/startup/choice authority; consistent.
  Producer protocol unchanged; no consumer change demonstrated necessary.

## Limits and decision

Approve the independent source/isolated-test review stage. This is not final
release acceptance. Chief must retain the owner-authorized Openclaw end-to-end
acceptance gate: NOT RUN, environment switch not authorized for this review.
Packaged Docker/TLS/crash proof in the implementation report was not independently
rerun. Full suite/build/lint were not rerun; focused checks cover this review.
Historical production log queries were not independently repeated; the reported
incident remains unreconstructed and prior default-on paths are only plausible
causes, not established causation or evidence of uploaded telemetry.

No implementation/test fixes, merge, deployment, npm publication or paid CI.
Evidence rollback: revert only this evidence commit. Implementation rollback and
its legacy automatic-mode risk remain as documented in live-tracking-confirmation.md.
