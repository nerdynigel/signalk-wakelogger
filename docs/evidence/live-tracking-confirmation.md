# Live tracking confirmation and durable intent

Source: `21831698c791eeaa8f9307edec3513c6712e7e0a`, based on main
`92a0bc3974a39da0ac6e53348c58ef68d2fd4785`, branch `release/2026-w42` in
`nerdynigel/signalk-wakelogger`. Recorded 11 October 2026.

## Behavior and compatibility

Both directions use a native browser confirmation modal naming the current and
requested state. Off also includes the existing offline-race warning. Polling and
controls are frozen before asynchronous preparation. Cancel does not POST.
The request must include `confirmed: true` and `expectedUploadMode`; unconfirmed
requests return 400 and a changed state returns 409 without saving or retrying.
This is an authenticated client contract, not proof against a malicious authorized
client falsely declaring confirmation.

The authority is `tracking-choice.json` in the Signal K plugin data directory:
`{version: 1, confirmed: true, uploadMode: "automatic" | "local_only"}`. The
confirmed route atomically writes, syncs and renames it after the options save,
before starting transmission. A safety pause overrides it after failed saves.
Interrupted generations and superseded enables cannot start an obsolete
transport. Initialization errors pause transmission.

New installs, legacy upgrades, missing/malformed/unreadable/unsupported state
start off. A legacy `uploadMode: automatic` setting cannot enable tracking.
Existing users must confirm ON once after this upgrade if they want uploads;
subsequent restarts and settings updates restore their confirmed choice.
An unpaired installation can explicitly exchange its saved pairing code while
tracking remains off. An already paired local recorder does not exchange stale
pairing codes or open MQTT connections.

The cloud consumer's existing telemetry/status protocol is unchanged. Off still
publishes the bounded retained local-only status and stops telemetry; recording
continues. No cloud webapp change is needed for this producer control. Clients
that write the plugin's tracking endpoint must adopt the confirmation contract.
The Docker and disposable Finish-cloud harnesses have been updated accordingly;
the Finish-cloud harness itself was not run against a cloud environment here.

## Criterion evidence

| Requirement | Executed evidence |
| --- | --- |
| Both modal directions/current and target | Focused Playwright `live switch confirms both directions` checks dialog text and both transitions, plus POST confirmation fields. |
| Cancel/error never silently enable | Playwright cancel in both directions, mobile 390x844 and keyboard Space; save-error readback; stale confirmation 409 with one write only. Integration rejects unconfirmed/stale requests and fails off on save failure. |
| Off and on survive restart/settings updates | Integration `restores both confirmed choices across restart and ignores configuration updates`; browser reload for both states. |
| Missing/malformed/unreadable/migration fail off | Seven parameterized integration cases: missing, malformed JSON, unconfirmed, unsupported version, directory/EISDIR, invalid mode and null. Legacy automatic configuration cannot override these. |
| Interrupted/overlapping saves | Existing pending-enable versus off test; shutdown waits for save and never starts obsolete transport; added interruption after choice rename proves restart off. |
| Race/reconnect do not silently enable | Onboard integration explicitly confirms ON, tests cloud/onboard authority, snapshot upload, and final retained local-only status/silence. The packaged disposable Signal K/TLS stack passed startup fail-off, rejection of unconfirmed ON, confirmed OFF/restart/OFF, confirmed ON/broker-outage/SIGKILL/restart/ON, and course/race progression gates without changing user intent. |
| No unconfirmed enabling code path | `src/index.ts`: constructor/start initialize off; initialise restores only validated confirmed state then checks safety guard; `/tracking` validates confirmation and expected state then persists before assigning mode; pauseTransmission only sets off. Transport startup, state callbacks and snapshot flushing are gated by active mode. Race/course/finish/progression routes do not assign automatic mode. |

Commands executed in the linked task worktree:

- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:public`,
  `git diff --check`: passed.
- `npm test` at frozen source: 289 passed across 42 files; one standalone MQTT broker test skipped because no broker URL was supplied. The tracking control suite accounts for 20 tests.
- `node --test test/webapp/services.test.mjs`: 35 passed.
- `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright npx playwright test --config test/webapp/playwright.config.mjs --grep 'live switch|cancel in either|failed mode save|stale tracking'`: 4 passed. Desktop 1280x800; cancel/keyboard case 390x844. Mocked Signal K HTTP responses; not independent acceptance.
- The first browser attempt could not locate its run-local browser cache. Reusing
  the already-installed host cache succeeded; no browser installation performed.
- Initial broader integration failures were old fixtures relying on config-driven
  enablement. Fixtures now confirm explicitly and wait for recorder readiness;
  the affected lifecycle/local/onboard suites subsequently passed (9 tests).

## Packaged live proof

`npm run test:docker` at the frozen source passed on Signal K 2.31.1 with
synthetic NMEA 2000 input, verified TLS pairing and MQTT, real application ACKs
and native Signal K resources. The stack began off after pairing and rejected
an unconfirmed enable before accepting the explicit confirmation contract.
OFF survived a native server restart with no cloud telemetry; four locally
recorded samples uploaded after confirmed ON. A broker outage plus SIGKILL and
restart preserved ON, recovered 14 samples (ACK 10 to 24), preserved current
state before backlog, and drained the queue. Native course updates, conflicts,
rounding/progress, reversal and a further restart passed without modifying the
tracking choice.

The installed package's `dist/index.js` and the local frozen-source build had
identical SHA-256:
`4cf8baf12f1081282400d5b248c3b47cbcf98ca9952477f2c722cd73cea5c736`.
Disposable project `signalk-wakelogger-e2e-3835003` was removed with its network
and volumes. An earlier snapshot run was deliberately terminated (143) and
cleaned up after a final initialization safety change; its results are
superseded, and this successful run covers the delivered implementation.

## Incident investigation

Read-only production Docker API and MQTT broker log queries succeeded (exit 0)
for 10 October AEST: `2026-10-09T14:00:00Z` to `2026-10-10T14:00:00Z`.
Both returned zero retained entries in that window. No raw logs, credentials,
host addresses or SSH key were retained in this repository. The run-owned
temporary SSH key was deleted after each read.

The cloud host does not provide vessel-side plugin logs in these containers.
No historical plugin state or click sequence can be reconstructed from the
available records. Before the fix, the constructor reported automatic even
before startup, and startup trusted a configuration default of automatic;
these are plausible paths for the reported transient display/enablement,
not an established explanation of the owner's incident. No evidence supports
claiming that the reported display resulted in a telemetry upload.

## Rollback and remaining acceptance

Revert the source commit to roll back; preserve plugin data and safety-pause
files. The old implementation again trusts configuration uploadMode and ignores
the new choice file, so reverting may restore legacy automatic behavior; any
release rollback must explicitly preserve an off configuration before restart.
No merge, deployment, npm publication or Openclaw switch was performed.

Chief source review, independent Verification and owner-authorized Openclaw
end-to-end proof remain open. Isolated tests do not satisfy the Openclaw gate.
Chief owns environment routing and final criterion reconciliation. The original
incident remains unreconstructable without retained vessel-side evidence.
