# Remaining DEV feature proof — 15 October 2026

Software checkpoint, 10:49–10:55 UTC. This is readiness evidence, not feature acceptance. Latest Chief handoff removes historical-photo gates and permits isolated synthetic DEV proof; production Go remains separate.

## Executed observations

- `pc-task show`: THE-882 in_progress, Software assigned, registered plugin workspace `4de0cc0f-95fe-4135-ad51-b3e73b77de8b`, no dependencies at start. Actual cwd/origin/status confirmed existing linked `.worktrees/THE-884`, `release/2026-w42`, clean, HEAD `095bcbd90b4248cd1d916465aa39d375f417aac2`.
- `git ls-remote origin refs/heads/main refs/heads/release/2026-w42`: main `80e4a1dae648cdac5e298d9c737321ed75d5067f`, release `095bcbd90b4248cd1d916465aa39d375f417aac2`. After `git fetch origin main`, relevant `git diff --name-only` across src/webapp/public/scripts/test/package files is empty. Initial comparison failed because the merge object was absent; fetched comparison passes.
- `ssh -o BatchMode=yes -o ConnectTimeout=8 openclaw`: host openclaw-echo, clock 2026-10-15 10:49:50 UTC, existing Scope A services running. No service changes.
- From web evidence worktree `wt-the-829-serving`, `ssh openclaw python3 - < docs/evidence/the829-scope-a/identity-check.py`: exit0. Exact web source `0010b20bae8d20d71d46c5d56d724396a4f2f6ec`, plugin `095bcbd90b4248cd1d916465aa39d375f417aac2`. 250 frontend tracked files, 13 HTTP JS assets, 164 generated plugin files and five served plugin assets equal frozen bytes. Build ID `vhYCnX7n05kOuXcbsGeoq`; ready/database/object_storage ok; isolated migration `20261014_0099`. Backend network internal=true; API/Signal K/broker/DB/MinIO only on that internal network.
- Scoped read-only Compose inspection confirms isolated broker has no host-published port, listener1883, anonymous access, persistence=false. This does not establish a receiver/API ingestion path or durable completion acknowledgement.

## Exact blocker

The documented credential-safe native readback uses `POST /api/agents/me/secrets/openclaw-signal-k-readonly-token/value` with the injected run identity. This returned HTTP403 Forbidden before any native GET. No token obtained, no secret output, no alternate credential or security-file lookup, no retry. The readback script therefore did not execute native navigation/tracking/course requests. Secret fetch is the operation denied, not a Signal K endpoint response.

`pc-task tasks` and `pc-task show THE-903` confirm an existing active Reliability assignment already owns DEV readiness/conditional exact-pair serving for native ETA, tracking recovery and Finish-to-cloud. Reuse that prerequisite; do not create a duplicate task or new card. Chief must reconcile the denied binding through the authorized capability owner. Software must not administer services.

## Criterion disposition at this checkpoint

| Criterion | New executed result | Remaining proof |
| --- | --- | --- |
| Served identity/isolation | PASS, command above | Recheck after any service/source change |
| ETA/shared VMG | NOT RUN native/served functional cases | Fresh native readback and isolated controlled timestamp/position/leg fixtures, all handoff boundaries; accepted local analytic61/backend26 unchanged |
| Tracking | NOT RUN real DEV persistence/control | OFF/ON restart, reconnect/race events, negative save/unreadable/recovery; previous mocked UI/source evidence retained |
| Finish | NOT RUN real DEV Finish/receiver | Disposable recording, actual HTTP identity/bounds/conflict/retry/restart and isolated receiver/API completeness; preserve historical14604 accepted/zero rejects evidence |
| Tides | NOT RUN new served rendering | Controlled plugin-recorded76/77-shaped input, high/low provenance, missing/partial/recovery, desktop/mobile; prior17 source/browser cases retained |
| Physical-current vessel | Unavailable from this checkpoint | No physical-current claim; synthetic telemetry must remain labelled |

## Bounded next action and rollback

Existing Reliability THE-903 should return a concrete usable checkpoint: authorized native read/write endpoint access for Software without printing values; a controlled fresh synthetic input path scoped only to this internal DEV instance; approved restart/fault steps for isolated tracking state with restoration; and an isolated receiver/API ingestion identity/configuration for Finish. Establish receiver/receipt plumbing before enabling automatic mode. Preserve shared/production data and current WIP; no restore/migration is required. Reuse existing readiness work rather than repeat setup already done.

Software resumes the SAME THE-882 on prerequisite completion, implements/runs remaining fixtures, publishes criterion evidence and then returns to independent Verification → Chief. No feature PASS is inferred from this checkpoint. Tide checks remain part of the same tranche, not a new dependency chain. No code, test, service, tracking, recording or native route mutation occurred here. Rollback: scoped revert of this evidence file only. Existing serving rollback stays with Reliability; production remains untouched.
