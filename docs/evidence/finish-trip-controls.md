# Finish Trip controls — THE-883

Repository: nerdynigel/signalk-wakelogger. Workspace: `.worktrees/THE-884`,
`release/2026-w42`, registered projectWorkspaceId
`4de0cc0f-95fe-4135-ad51-b3e73b77de8b`. Clean starting revision:
`1023c35becd6baa968c88a3422bb3a421affbc87`. Tested implementation is the commit
containing this document; its full published SHA is recorded on THE-883.

## Demonstrated defect and correction

At the baseline, `webapp/app.mjs`'s `renderTracking` disabled Finish for an ended
recording with ready confirmation, no recording, unavailable status/recorder,
or a pending control request without explaining the Finish-specific gate.
Its Finish error handler discarded backend reasons. Pre-fix actual-page
regressions failed because `#finish-trip-reason` did not exist and a
`recording_not_committed` response yielded only the generic retry message.
This demonstrates a control/presentation defect, not the historical incident.

`webapp/tracking-controls.mjs` now supplies the shared render/click gate and an
explicit visible reason linked through `aria-describedby`. Active Finish
remains independent of queue emptiness, cloud readiness, upload mode and race
state. Ended trips distinguish saved onboard from exact cloud confirmation;
confirmation retry stays available. Busy, unpaired, revoked, unavailable and
no-recording states explain why Finish is disabled. Backend unsafe-tail,
changed-recording, unavailable and permission failures have actionable messages.
A timeout explicitly says the save outcome may be unknown; refresh reconciles
state before an operator retries. Existing five-second request deadlines,
three-second polling, single-submit guard and identity checks are retained.
No storage/protocol/threshold/backend change was needed.

## Executed validation — 11 October 2026

Node v24.21.0 was already installed but absent from this run's PATH. Commands
used `/home/nigel/.nvm/versions/node/v24.21.0/bin` in PATH and
`PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright` for the existing
Chromium 1208 installation. The initial browser launch using the run cache
failed before assertions; no browser installation was performed.

| Requirement | Executed command / evidence | Result |
|---|---|---|
| Active Finish, empty queue/offline cloud, race conflict, ended/unavailable states, refresh recovery, timeout, unsafe tail, double submit, manual/auto closure | `npx playwright test --config test/webapp/playwright.config.mjs --grep 'Finish\|automatic closure during manual\|tracking\|cancel in either'` | 10 passed; actual built page, synthetic routed responses |
| Every local control gate; cloud-authority semantics; request-body deadline; preserved TWA | `node --test test/webapp/services.test.mjs` | 37 passed |
| Durable Finish/retry/restart, append serialization, failed tail refusal, stale identity, ACK persistence recovery, preserved tracking authority | `npx vitest run test/integration/tracking-controls.test.ts` | 20 passed |
| Automatic stop/manual race, committed bounds, idempotency, persistence failure, exact ready vs receipt ACK | `npx vitest run test/unit/recording-store.test.ts test/unit/trip-state-machine.test.ts` | 18 passed |
| Implementation live local flow | `node scripts/test-finish-local-e2e.mjs` after `npm run build` | PASS: actual compiled plugin + real loopback HTTP + Chromium keyboard Finish; exact durable id/last sequence/end timestamp, confirmation retry, reload, restart; no MQTT/native writes |
| Build and repository hygiene | `npm run build`, `npm run lint`, `npm run check:public`, `git diff --check` | Exit 0 |

The new local E2E runner uses synthetic credentials in a temporary directory and
cleans up its browser, plugin, HTTP server and data. Signal K subscriptions are
an adapter fixture; it is not a real Signal K or cloud/Openclaw proof. Its first
run hit ENOENT while polling a not-yet-created checkpoint; the runner was fixed
to wait only for that expected initialization condition and passed twice.
Backend tests and local E2E execute real durable storage. Browser route tests
prove page behavior but do not establish cloud or automatic-stop timing.

## Acceptance still open

Discovery revision 2 on THE-883 establishes all 14,604 distinct sequences in the
declared recording bounds were accepted, none rejected, with matching cloud
processing revisions. That is prior read-only evidence, not rerun here; it does
not establish complete physical capture given unattributed lifetime drops.

The reported ~05:00 UTC failure on 11 October cannot be attributed: onboard
incident tracking JSON, busy/request state, logs and served/loaded asset hashes
remain unavailable. The terminal manifest at 05:11:47 UTC is not evidence of
button state at ~05:00. Do not call automatic closure the incident root cause.

Chief source reconciliation, independent Verification of the frozen candidate,
and owner-authorized Openclaw finish-to-cloud proof remain required. No release
pass, incident-root-cause claim or acceptance waiver follows from these checks.
No production replay, deployment, merge, npm publication or paid CI was run.
The integration PR remains #22.

Rollback: revert the task commit on the integration branch. This removes UI
presentation/regressions and the disposable local runner; no data migrations,
protocol changes or production mutations require reversal.
