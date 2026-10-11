# THE-882 independent frozen review — changes requested

11 October 2026. Verification & Release Engineer, reporting directly to Chief.
This is source/local QA, not release acceptance. No product changes.

## Identity and delivery

- Plugin `nerdynigel/signalk-wakelogger`, release/2026-w42,
  `49285dd76499428c4676ce7e7a98ed576530eff8`, draft PR22.
- Website `nerdynigel/wakelogger`, release/2026-w42-web,
  `74454ddc9c38addfa66307cd554b29f3baeb1c4b`, draft PR81.
- Independently ran git ls-remote for both release heads: exact matches.
  Plugin linked .worktrees/THE-884 clean; website registered sibling
  .paperclip-runtime/wt-w42 has only pre-existing untracked frontend/node_modules.
  Source pins remained unchanged during review. Evidence uses a separate branch.

## Executed checks

N = /home/nigel/.nvm/versions/node/v24.21.0/bin/node, version24.21.0.
Commands ran from the respective frozen worktree, ordinary user privileges.

| Command | Result |
| --- | --- |
| Plugin: N --test test/webapp/services.test.mjs test/webapp/eta.test.mjs | PASS73 |
| Plugin: N node_modules/vitest/vitest.mjs run test/unit/dynamic-golden.test.ts test/unit/onboard-plan.test.ts test/integration/onboard-race-plan.test.ts | PASS22 |
| Plugin: N scripts/build-webapp.mjs | PASS exit0 |
| Plugin: PATH includes Node bin; PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright; N node_modules/@playwright/test/cli.js test --config test/webapp/playwright.config.mjs -g 'ETA native' | PASS1,1280x800,23.4s |
| Website: N --test frontend/tests/race-plan-timing.test.mjs | PASS12 |
| Website api: ../../wt-integration/.venv/bin/python -m pytest --noconftest tests/test_race_eta.py -q | PASS16, one AnyIO deprecation warning |
| Website frontend: N node_modules/next/dist/bin/next start -p3399; repository frontend/e2e/eta-mocked.cjs | PASS1200x900 and390x844, unknown propagation, long forecast dates, recovery, unavailable live reason; no page exceptions or unexpected writes |
| Plugin: git diff 0e8ef2d7419a5cd63ef28149b0be0f4db962eac6 49285dd76499428c4676ce7e7a98ed576530eff8 --check | PASS |
| Website: git diff e6b5e32b4a46df8eace5dd4f7370d5f28e90b1d2 74454ddc9c38addfa66307cd554b29f3baeb1c4b --check | FAIL exit2: frontend/app/lib/racePlanTiming.js:47 blank line at EOF |

Browsers used isolated REST fixtures and local pages; server was stopped.
Website browser used the existing build; no fresh web build or artifact-byte
identity established by this review. Source tests independently use exact frozen
bytes. No container/production/Openclaw operations. Existing package2014 replay
is reused as implementation evidence, not independently rerun or current-native
positive proof. Published source reports were inspected, not trusted as QA passes.

## Blocking finding: forecast legs can start before preceding explicit finish

`frontend/app/race-plan/RacePlanClient.js` around1449 computes each next start
from planned_start_time + summed legDurationHours. It does not carry the prior
leg's explicit estimated_finish_time. `racePlanTiming.js:31` validates explicit
starts against that duration-based lower bound rather than the preceding finish.

Deterministic actual-source reproduction:

- Planned start2026-10-11T12:00:00Z.
- Leg1 distance1nm, speed5kn, explicit startOct11 12:00Z, explicit finish
  2026-10-15T16:00:00Z. Explicit finish is supported and accepted by the helper.
- Derived legDurationHours is0.2. Leg2 without explicit start yields
  2026-10-11T12:12:00.000Z, before leg1 ends.
- Leg2 explicit start2026-10-12T12:00:00Z is likewise accepted, before leg1 ends.
- Both monotonic-order comparisons return false.

Reproduce with N docs/evidence/eta-order-repro.mjs /absolute/path/to/website/worktree.
The script loads the frozen helper bytes and follows the actual page loop.
This is a confirmed source defect; no historical incident attribution claimed.

Software must carry authoritative preceding finish through leg scheduling,
reject overlapping explicit starts, preserve unknown propagation and valid long
forecasts, and add regressions for both mixed explicit/derived timing and explicit
overlap. Correct the whitespace failure and supersede the published diff-check
PASS. Return new exact pushed pins for independent recheck. No QA product fixes.

## Acceptance and limits

Existing tests prove cached/native fixture availability gates and representative
normal, stationary, drifting, tack/away, stale/recovery, tiny-speed/date boundaries.
Cloud live ETA remains intentionally unavailable for absent individual source
provenance; this is the authorised interim fallback, not positive cloud proof.
Public tactical exclusions pass the actual service fixture.

Ordered forecast correctness FAILS the reproduction above. Race-day input values,
deployed identity and surface remain unknown. Current physical-native positive
proof remains Software-owned and NOT RUN. Openclaw remains NOT RUN pending frozen
owner Go. Fixture native envelopes do not establish real current telemetry.
No candidate/release approval, production mutation, merge, npm or paid CI.
Chief owns final acceptance reconciliation and serial discovery holds.
Rollback remains scoped revert of each ETA implementation commit; no migration.
