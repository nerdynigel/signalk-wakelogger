# THE-882 isolated fixture preparation — 15 October 2026

Partial Reliability delivery. Tide fixture ready; Race Pack retained but NOT received. Full feature acceptance remains OPEN. Repository `nerdynigel/signalk-wakelogger`, registered workspace `4de0cc0f-95fe-4135-ad51-b3e73b77de8b`, linked `.worktrees/THE-884`, branch `release/2026-w42`, starting commit `e5eefd6af2f7a62d002890222fbd19fc483b3177`. Frozen plugin product `095bcbd90b4248cd1d916465aa39d375f417aac2`, web `0010b20bae8d20d71d46c5d56d724396a4f2f6ec`. No product edit, deployment, paid CI, production operation or new PR. Existing [PR22](https://github.com/nerdynigel/signalk-wakelogger/pull/22) is already merged; this adds evidence to its release branch.

## Executed results

- Fresh run-granted Signal K RO/RW and disposable user2 identity used only in memory. Login user2 and vessel4 ownership confirmed. Exact API/Signal K/DB/broker containers are running solely on the internal `wakelogger-scope-a_isolated` network with no published ports. Remote operations used ordinary nigel SSH/Docker privileges; no sudo required.
- Tracking remains `local_only`/OFF throughout, active local recording `5f835fd9-cd30-45ab-bd08-454c2416e1ec` preserved. Queue792/current1439/ACK647/dropped0 unchanged. Complete receiver recordings, voyage4 and explicit course/leg marker unchanged. STOP_CANDIDATE is the actual final local-recording state; no Finish or recording creation was replayed.
- Tide setup PASS: narrowly synthetic voyage4 environment snapshot and one exact plan25 daily LAT cache key. Initially voyage4 had zero environment snapshots and this cache key was empty; no existing row overwritten. Real `POST /v1/race-plan/25/recalculate` returns200 with four numeric events (high1.8m at00:00/12:00 UTC, low0.2m at06:00/18:00 UTC), source_type=model, atlas=`THE882 synthetic`, explicit model warning. Real `GET /v1/voyages/4` exposes numeric start1.1/end1.2/min1.1/max1.8m and three bracketing/in-trip events. These are synthetic fixtures, not external-provider accuracy evidence.
- Rollback PASS: deleted only fixture snapshot/cache ids1/1, published retained clear revision2 and removed obsolete chunk0. Real recalculation returned source_type=unavailable/events0; voyage4 tide fields returned null/events0. Pack remained unavailable. Then setup reapplied with new snapshot/cache ids2/2 and retained pack revision3. Positive final receipts in [setup](dev-fixture-setup.json); removal in [rollback](dev-fixture-rollback.json).
- Five served plugin modules remain byte-equal to frozen generated local bytes at both checks. Source/image hashes, container identities/start times and disk receipts are in [readback](dev-fixture-readback.json). Services were not restarted.

## Race Pack constraint — NOT PROVEN

Cloud `build_race_pack_document` and `build_transport` generated plan25’s current course/digest (`2342f0a86d7362a72d32c5d90e6ba78a54c97a1607dd90f5b5fe6519477a59b0`), valid current twelve-hour forecast with hourly samples, supported rule set and canonical SHA256. Retained chunk0 then manifest were published QoS1 using the existing worker identity and service configuration. No ACL, identity or credential changes were made. Final revision3 is staged on the isolated broker; plugin `/race-plan` still reports pack.available=false. No applied ACK was observed and publication alone is not receipt proof.

Initial setup inserted ids1/1 and published revision1, then timed out waiting15s for a matching ACK. Read-only inspection found the reason in frozen `src/index.ts`: connectTransport at958 is invoked only for automatic mode at1061; local_only creates an inert transport at1007–1009. OFF disconnects MQTT. The failed attempt did not change tracking or queue; its rows/publications were reconciled through rollback, not blindly replayed. The revised driver explicitly records empty ACKs instead of claiming success. Existing broker worker/device race-pack ACLs were read back and present; no backend permission denial or ACL repair occurred.

Chief must reconcile this constraint before Software can prove numeric provisional ETA: normal broker receipt requires a separately authorized brief automatic-mode interval (which can drain the preserved outbox), or a specifically approved offline receiver/store fixture. Neither is implied by the current instruction to preserve OFF and queue/ACK. Do not silently enable uploads or insert a pack into the store and claim MQTT receipt. Retained revision3 remains available for the selected path; validUntil is in its receipt. Full acceptance stays open.

## Commands and recovery

Executed from the assigned repository:

```text
python3 .worktrees/THE-884/docs/evidence/dev-fixture-setup.py setup   # initial ACK timeout, reconciled
python3 .worktrees/THE-884/docs/evidence/dev-fixture-setup.py rollback
python3 .worktrees/THE-884/docs/evidence/dev-fixture-setup.py setup   # final staged pack + positive tides
python3 .worktrees/THE-884/docs/evidence/dev-fixture-readback.py
```

The orchestrator sends the committed [API fixture driver](dev-fixture-api.py) via stdin to `docker exec -i wakelogger-scope-a-api-1 python - <setup|rollback>` after fresh isolation assertions. Broker connection credentials remain in existing API settings memory. It uses the normal cloud builder/framing and existing worker client configuration; no credential files or environment dumps are persisted. The helper’s single-use receipt guard prevents unreviewed replay.

Private recovery state is `/scopea-backups/the882-fixture-20261015.json` inside the API container’s existing backup volume, mode0600: fixture row IDs, revision and prior plan calculation only. It contains no credentials. Current rows2/2 belong to this fixture. For final cleanup, Reliability should preserve the existing rollback receipt under a new descriptive evidence filename, then run the same rollback orchestrator once, verifying row identities, null voyage tide fields, unavailable plan tide source and pack state. Do not delete existing rows broadly or restore the database. Clear revision4 supersedes staged revision3; chunk0 removal is scoped to this device. There is no applied pack to clear while OFF; ACK absence must remain disclosed. Plan recalculation can update ordinary calculation timestamps; no schema, route or recording state is restored. Retain the private evidence volume.

Software owns the remaining real-page desktop/mobile positive graphics/high-low/provenance and partial/missing/recovery proofs. It should use the real API fixture and name any additional serialized fixture transitions needed; this preparation is not browser acceptance. Return only complete criterion evidence to independent Verification then Chief.

## Browser allowance and validation

Installed one scoped allowance, read back as added, for Verification agent `089a4259-cb74-4ea9-8f3f-c33555f7c841`, this project and THE-882 only:

```text
PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright npx playwright test --config test/webapp/playwright.config.mjs -g "leg-average ETA"
```

Exact denial source: Verification comment `da2846c6-eeb6-4de9-9e37-c62b0d85492a`. Command: `pc-allowance add` with those three scope identifiers, exact command and denial evidence. Readback confirms one entry; helper retained its rollback backup. No browser test was fired by Reliability; next Verification run uses it.

Validation: Python AST and JSON parsing, recursive sensitive-key scan, public-repository guard, staged/committed diff checks; runtime setup/rollback/readback assertions. Full product suite at unchanged e5eefd6 is reused from independent review (294 passed/1 existing skip). A first plain `node` invocation failed because node was absent from login PATH; the known absolute Node binary ran the public guard successfully. No package installation or product suite replay.

Hygiene: before local `/`121GB available/54% used, `/tmp`190MB/1%; target final and local final in readback. No cleanup threshold crossed. Paths removed for hygiene none, bytes reclaimed0; all active worktrees, recordings, outbox, archives and private evidence retained.
