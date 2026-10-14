# Independent Finish Trip source review — THE-883

Reviewed 11 October 2026 by Verification & Release Engineer, reporting to Chief.
Repository: nerdynigel/signalk-wakelogger. Frozen source:
`7a3106e91f20449d33ad47212a039211d54c144a`, release/2026-w42, draft PR #22.
Isolated detached QA worktree `.worktrees/THE-883-qa` within registered plugin
workspace 4de0cc0f-95fe-4135-ad51-b3e73b77de8b. Source worktree initially clean;
origin branch and GitHub PR head independently matched the full source SHA.

## Independent results

Node v24.21.0; existing Chromium via
`PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright`.
All final commands below exited 0:

- `npm run build`: compiled frozen TypeScript and webapp source.
- `node --test test/webapp/services.test.mjs`: 37/37 PASS, including control
  gates, cloud authority, request-body deadline, tracking and TWA.
- `npx vitest run test/integration/tracking-controls.test.ts test/unit/recording-store.test.ts test/unit/trip-state-machine.test.ts`:
  38/38 PASS (20 integration, 15 recording-store, 3 state-machine). Real durable
  storage covers append serialization/exact bounds, failed-tail refusal,
  stale identity, retry/restart and ACK persistence recovery.
- `npx playwright test --config test/webapp/playwright.config.mjs --grep 'Finish|automatic closure during manual|tracking|cancel in either|TWA'`:
  11/11 PASS in Chromium. Actual built page with synthetic routed responses:
  Finish with offline/empty queue and race conflict; unavailable/no-trip/ended
  reasons; unsafe-tail and timeout recovery; busy single-submit; keyboard retry;
  stale identity; automatic/manual closure; tracking cancellation/readback;
  TWA and desktop/mobile fullscreen. Default viewport 1280x800; fullscreen test
  includes mobile viewport. These fixtures do not prove cloud behavior.
- `node scripts/test-finish-local-e2e.mjs`: PASS, actual compiled plugin,
  loopback HTTP and Chromium keyboard Finish. Exact durable recording ID,
  last sequence and end timestamp; idempotent confirmation retry, reload and
  restart; no MQTT or native writes. Signal K adapter is synthetic.
- `git diff --check`: PASS. Build did not change tracked source.

Initial isolated-worktree build failed with ENOENT for local Leaflet assets;
its incomplete-page browser attempt was stopped (3 failures, 1 interrupted,
7 not run). A first dependency symlink was accidentally nested inside a
created node_modules directory and build still failed. Moved that QA-only
transient directory to run scratch, linked the existing installed integration
worktree dependencies correctly, rebuilt, and obtained the final passes above.
No package/browser installation or product/test fix was made. The initial
browser results are invalid artifact checks, not hidden product failures.

## Decision and limits

Approve independent source/local checkpoint only. Code review confirms shared
render/click gates ignore upload/race readiness for active Finish, show explicit
disabled explanations through aria-describedby, preserve identity/single-submit
checks, and expose actionable backend failures. No implementation defect found
in the reviewed scope. This evidence-only successor leaves frozen source intact.

NOT RUN: owner-Go final frozen W42 Openclaw finish-to-cloud proof. Historical
~05:00 UTC button failure remains unattributed; onboard incident state/logs and
served asset hashes are unavailable. Earlier discovery's 14,604 accepted unique
declared sequences, zero rejects, is referenced rather than independently
recollected here; it does not establish complete physical capture. The later
05:11:47 terminal manifest does not establish the button state at ~05:00.
Chief owns final reconciliation and these remaining original acceptance gates.
No production replay, deployment, merge, npm publication or paid CI.

Rollback: revert this evidence-only commit to remove this report; source rollback
remains the implementation's scoped revert. Published evidence SHA is recorded
on THE-883 and independently verified against origin.
