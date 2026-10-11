# Plugin leg-average ETA / VMG — source checkpoint

Software & Protocol Engineer; 12 October 2026. Repository
nerdynigel/signalk-wakelogger, release/2026-w42, consolidated draft PR22.
Product source: eafc2d794cdde313d0b96374cf7058b638c9e826.
Supplemental runtime test: a41fa6f5d19001ed72a32043cfed8f7ec55d8969. This successor changes only the
integration test; product source and generated build inputs are identical.

## Computation and provenance

The previous candidate accepted native calcValues ETA or divided remaining
mark distance by instantaneous VMG. Prior deterministic tiny-positive scalar
reproductions and historical production investigation remain in eta-source.md
and eta-production-investigation.md. Exact race-day screen attribution remains
UNKNOWN. This source checkpoint replaces the plugin calculation, not production.

CourseStore records one durable local activation/observed-course-advance marker.
The identity includes selected course/revision/update time, active index, native
route versus cached reference, reverse flag and selected geometry. Controlled
activation records the event time; native transitions are observed on status
reads and the existing 10-second background cadence. A fresh source position
at that event provides the baseline (timestamp at/before event, age <=30 seconds).
Subsequent samples never replace this baseline. Explicit activation resets it;
duplicate retained delivery and server/page restarts preserve it. Clear, advance,
reverse and course/reference changes reset the identity. Checkpoints keep the
existing atomic rename/fsync and private-file permissions.

A first attachment to an existing route without a saved marker cannot recreate
historical activation: numeric ETA is unavailable until a recorded activation
or transition. If activation has no fresh baseline, the first-minute matching
plan may be provisional; after that minute no numeric average is fabricated.
Fresh samples arriving midway through such a leg do not silently rebase it.
External native advance time is the *observed* transition time (up to background
poll latency), not a retrospective source event timestamp; this limitation must
be checked in native acceptance. Position sampling at the event has the existing
30-second freshness uncertainty; no interpolation or fictitious coordinates.

`webapp/leg-eta.mjs` supplies reusable DOM-independent great-circle projection:
signed along-axis endpoint progress minus start-position projection, in metres,
divided by elapsed hours since the recorded activation, converted to knots.
Net lateral track mileage does not count. Remaining distance / positive average
produces TTG; injected now + TTG produces ETA. Native instantaneous VMG, TTG and
ETA are never estimator inputs. Native distance/bearing still retain their own
freshness requirements; cached distance/bearing remain geometric. A changed
native resource geometry cannot reuse a baseline for another axis.

Minimum averaging window: 60 seconds. Below it, use only the matching applicable
leg plan's estimatedSogKnots, bounded 0.5–30 kn, same course/index/reverse/pack
revision, snapshot no older than 20 minutes. Otherwise suppress with a reason.
No instantaneous fallback. UI labels the race metric “Leg-average VMG (ground)”;
plan speed adds “(plan)” and ETA states “Provisional · leg plan speed”. Existing
wind/water instrument VMG meanings are preserved separately.

Nonpositive progress, invalid geometry, missing baseline/sample provenance,
invalid/stale/skewed sensors and invalid dates suppress ETA. Live duration is
finite, nonnegative and <=86400 seconds; average >30 kn also suppresses. The
30-second age / 10-second skew / 5-second future sensor guards remain. Fresh
position updates recalculate continuously without waypoint advancement. Tack or
instantaneous stationary motion does not override a positive accumulated average.

## Executed evidence and limits

Node24.21.0: prepend /home/nigel/.nvm/versions/node/v24.21.0/bin to PATH.
Commands below exited0 against product source eafc2d7 unless stated otherwise:

- `node --test test/webapp/eta.test.mjs test/webapp/services.test.mjs`: 60 PASS,
  no skips. The 17 ETA cases cover conflicting instantaneous/native values,
  stationary/drift/away/epsilon net progress, lateral displacement, updates,
  below/at/above 60-second transition, missing/invalid bounded fallback, wrong
  plan provenance, native/cached stale/invalid/missing/future timestamps, skew,
  marker replacement, invalid inputs, exact 24-hour boundary/overflow, and missing
  activation position (provisional only; never a late rebase).
- `node node_modules/vitest/vitest.mjs run test/unit/course-store.test.ts
  test/unit/race-progression-service.test.ts test/unit/reverse-course.test.ts
  test/integration/onboard-race-plan.test.ts test/integration/lifecycle.test.ts`:
  36 PASS across five files, no skips. Marker persistence/reset/source rejection
  and unchanged progression/reverse/lifecycle boundaries exercised locally.
- Additional runtime test at a41fa6f5d19001ed72a32043cfed8f7ec55d8969: `node node_modules/vitest/vitest.mjs run
  test/integration/onboard-race-plan.test.ts`: 5 PASS. Actual plugin constructor,
  subscription callback and course HTTP handlers consume synthetic native deltas;
  invalid timestamp cannot seed a baseline, explicit activation uses fresh source,
  subsequent fixes do not rebase, restart retains it. Fake native API and local
  credentials are test fixtures; no physical vessel or production connection.
- `node scripts/build-webapp.mjs`; `node node_modules/typescript/bin/tsc
  -p tsconfig.build.json`: PASS. Public assets and compiled backend generated.
- `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright node
  node_modules/@playwright/test/cli.js test --config test/webapp/playwright.config.mjs
  --grep 'leg-average ETA page'`: 1 PASS, Chromium, 1280x800, 20.7s. Actual generated
  plugin page at local4178 with mocked Signal K/course/plan HTTP inputs; confirms
  label, numeric average despite wrong native ETA, stale and nonpositive suppression,
  recovery, reload persistence, cached route and visible provisional plan. No page
  errors or navigation writes. Initial default cache launch failed (browser absent);
  rerun used the existing provisioned shared cache, no installation.
- Scoped ESLint --max-warnings=0 on changed TypeScript and tests; tsc --noEmit;
  Node syntax checks for changed modules; check-public-repo; git diff --check: PASS.
  Newly added integration test also passes scoped lint/typecheck at its source pin.

The backend/page proofs are implementation-level local fixture evidence. They do
NOT supply physically-current positive/invalid/stale/recovery or owner-Go
Openclaw acceptance. Independent Verification of the changed source follows
Chief review. Previous native-only ETA tests were replaced because those assertions
would enforce superseded semantics; unchanged service and instrument contracts
remain tested. Existing host report is integrated byte-for-byte from independent
verifier ccb0f98583c3c679e7d95f2f64ea42c664351d36 in the web repository,
with original attribution and source pins. Its unchanged-plugin claim describes
the historical pair; it does not certify this new product source.

## Website assessment / rollback / final gate

Website adoption would materially replace currently unavailable numeric live
next-mark ETA with this averaged result. It requires durable leg activation/index,
start position and timestamp, coherent leg geometry, individually timestamped
fresh positions/distance, and matching fallback plan provenance. Current cloud
rows do not establish that complete provenance. No web numeric wiring or protocol
expansion is delivered; Chief must reconcile that scope before any adoption.
Web consolidated branch receives only attributed host-report integration and this
assessment. Planned leg/finish forecasts remain a distinct calculation.

No production access/mutation, Openclaw switch, deployment, merge, npm publication,
new PR or paid CI. Original incident/native/Openclaw gates stay OPEN. Chief freezes
the delivered pair and routes independent changed-source verification; Software
retains missing implementation-level live proof. This is not release acceptance.
Rollback: revert the two scoped source/test commits and this evidence commit,
rebuild normally. Older code ignores the optional legStart checkpoint field;
no database migration or telemetry wire change.

## Generated build identities (SHA256)

- `src/courses/course-store.ts`: `9561f51b54232e6dfa75968c04fdc734e6130ee97ef22fb65d3904d255a0de77`
- `src/index.ts`: `485dabfdc21e4cbf5303cb2b488dd02f316f5b3cde5c493760ff1d893d29ab28`
- `webapp/leg-eta.mjs`: `7efdcd311533aa72e49c9c8e053209b04107103674772b5f464c5ac52c68acb6`
- `webapp/course-progress.mjs`: `c3beb6cf8f6d9ffa18dfdc92d4c50528aaeb5aca4532e536a92c544d74c9245e`
- `dist/courses/course-store.js`: `ee738f4b1f6a54794caf1c15e727c1cbbcfd0b68c95d6fe2dbea03316430860a`
- `dist/index.js`: `038320bc9faf125fe55ecddf4c8fd19b99bc85d0a19c2432597a15b87e1f42c7`
- `public/app.mjs`: `03c00d40b3e2faae762c341a98cb75ecc42ba91843aa5b0565d21e3bd5d26c77`
- `public/course-progress.mjs`: `c3beb6cf8f6d9ffa18dfdc92d4c50528aaeb5aca4532e536a92c544d74c9245e`
- `public/leg-eta.mjs`: `7efdcd311533aa72e49c9c8e053209b04107103674772b5f464c5ac52c68acb6`
- `public/index.html`: `a233a0ffaec1f84f63ef509f2beaef4bf33e0656bc4cedb0cb647197358c2647`

## Inclusive 30 kn correction — 12 October 2026

Affected product/test revision: `56ad09bab44f9ddf25bb4af716d92e2b5f4bf4fb`.
This section supersedes only the upper-boundary result and leg-eta build hash
above; all original physical/live/Openclaw gates remain OPEN.

Verification's published report and analytic reproduction are integrated exactly
from `ede232791d7d2a0c144a5aa6ff78fd28b735874f`, retaining original attribution,
FAIL decision and historical pins (`leg-average-independent-review.md` and
`leg-average-independent-check.mjs`). Before editing, executing that harness in
its original review tree reproduced exit1: exactly 30 nautical miles of progress
in one hour yielded 30.000000000000004 kn and null ETA. That is floating-point
projection roundoff at the inclusive sailing limit, not historical incident proof.

Only calculated averages in `(30, 30 + 1e-12]` kn normalize to 30 before shared
VMG/ETA output. Provisional plan limits remain strict. No lower, date, freshness,
geometry, baseline/reset or elapsed-window guard changed. A 1e-12 kn tolerance
is negligible measurement-wise and preserves suppression already at 30+1e-9 kn.

Executed with Node v24.21.0 against this product revision (exit0 unless noted):

- `node --test test/webapp/eta.test.mjs test/webapp/services.test.mjs`: 61 PASS,
  no skips. New boundary regression asserts VMG exactly30, TTG120 seconds and
  numeric ETA for one mile; 30+1e-9, 30.0001 and30.01 kn suppress with the sailing
  range reason. Above-limit provisional plan remains rejected. Existing lower,
  24h/date, freshness, missing-baseline and recovery assertions pass.
- `node docs/evidence/leg-average-independent-check.mjs`: PASS including the
  previously failing exact30 assertion; original harness unchanged, now importing
  corrected candidate source. Analytic unequal-interval/offset-baseline,
  above-limit, fallback-window, freshness/recovery and geometry checks pass.
- `node scripts/build-webapp.mjs`: PASS. Generated ignored public assets rebuilt.
  `cmp webapp/leg-eta.mjs public/leg-eta.mjs`: PASS. Both SHA256:
  `f4d225c42bfb83a30017bc5bb5dd1c73741aa9e2c28feadcd217c172484e8fe4`.
  app/course-progress/index and backend sources remain unchanged.
- `PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright` with Node24 on PATH,
  `node node_modules/@playwright/test/cli.js test --config test/webapp/playwright.config.mjs
  --grep 'leg-average ETA page'`: 1 PASS, Chromium1280x800,20.8s. Existing actual
  generated-page mocked-input flow retains label/provisional/stale/recovery/reload
  checks and no page errors/writes; new page-context import of served leg-eta module
  asserts numeric exact30 and suppressed30.0001. This is local implementation
  evidence, not independent verification or physical-source acceptance.
- `node scripts/check-public-repo.mjs`, exact byte comparisons of both attributed
  verifier files against the published review checkout, `git diff --check`: PASS.

Website numeric adoption remains unwired; no affected website code or evidence
requires publication there. Attributed host report was already integrated at the
previous source checkpoint and is reused, not copied again. Independent affected
source recheck owns the next review stage, followed by Chief reconciliation.
Current physical positive/invalid/stale/recovery and owner-Go Openclaw NOT RUN;
exact race-day incident UNKNOWN. No production action, candidate promotion,
deployment, switch, merge, npm or paid CI. Rollback: revert56ad09b and rebuild;
evidence can be reverted separately. No migration.
