# Independent leg-average ETA review — changes requested

Verification & Release Engineer, 12 October 2026; reporting directly to Chief.
Reviewed plugin nerdynigel/signalk-wakelogger release/2026-w42
ac245c3300362aa170ada7d2d2828e0377905bce, draft PR22/main;
web nerdynigel/wakelogger release/2026-w42-web
54a332f0fb8d2cf4ee675f4685afce4f170d8b82, draft PR81/master.
Executed git ls-remote and gh pr view --json headRefOid,url for both:
remote and PR full SHAs match. Review used isolated linked
.worktrees/THE-882-evidence, review/THE-882-eta-evidence. Ordinary merge of
candidate into previous attributed evidence branch; no release-branch writes.
Product src/webapp/test trees exactly equal candidate (git diff empty).

## Decision and reproduction

Request changes for the explicitly requested inclusive 30 kn boundary.
The independent harness leg-average-independent-check.mjs uses an equatorial
position exactly 30 nautical miles along the leg after one hour. Projection
produces 30.000000000000004 kn; webapp/leg-eta.mjs rejects speed >30 and returns
null ETA, reason “Leg average outside sailing range”. Expected numeric ETA
for the stated <=30 kn limit. This is a narrow floating-point boundary defect,
not evidence of a typical-speed failure or the historical incident cause.
Fix with a suitably small numerical tolerance/normalization and preserve
suppression of meaningfully above-limit speeds. Add the exact boundary regression.
Do not widen sailing limits or remove the guard. Test-only oracle correction:
initial strict equality of equivalent projections differed by 4e-16 kn; changed
to a 1e-12 tolerance. The reported product failure remains reproducible.

## Executed commands and evidence

Node v24.21.0 via /home/nigel/.nvm/versions/node/v24.21.0/bin/node.
Dependencies reused through an untracked symlink to existing THE-884 node_modules;
no install, package/pin or infrastructure changes.

- node --test test/webapp/eta.test.mjs test/webapp/services.test.mjs:
  exit0, 60 PASS, no skips. Inspected assertions for signed/lateral progress,
  disagreeing native/instantaneous values, 59999/60000/60001ms transition,
  fallback provenance, native/cached stale/invalid/recovery, 24h/date guards.
- node node_modules/vitest/vitest.mjs run test/unit/course-store.test.ts
  test/unit/reverse-course.test.ts test/integration/onboard-race-plan.test.ts:
  exit0, 26 PASS, no skips. Actual plugin callback plus activation baseline,
  missing timestamps, no late rebase, restart persistence, duplicate activation,
  route/index/reference/reverse/clear resets and unknown initial attachment.
- node scripts/build-webapp.mjs: exit0. Generated public leg-eta/course-progress/
  app/index hashes exactly match all four candidate hashes in leg-average-eta.md.
- PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright
  PATH=/home/nigel/.nvm/versions/node/v24.21.0/bin:$PATH node
  node_modules/@playwright/test/cli.js test --config test/webapp/playwright.config.mjs
  --grep 'leg-average ETA page': exit0, 1 PASS, Chromium 1280x800, 20.6s.
  Actual freshly generated page on local4178; mocked native/cached inputs.
  Label/units, numeric average despite conflicting server ETA, stale/nonpositive
  suppression, recovery, reload persistence and visibly provisional plan verified.
  Browser/page-error assertions passed; no physical source or Openclaw used.
- node docs/evidence/leg-average-independent-check.mjs: exit1, exact30kn FAIL.
  Before final failing assertion, independent endpoint/unequal-interval analytic
  expectations, offset baseline subtraction, above30 suppression, exact30000ms
  baseline age versus30001, inclusive .5/30 plan fallback, no fallback at60s,
  exact sensor age30s versus30.001s, recovery and changed native geometry passed.
- git diff --check: exit0. Source inspection confirms common estimator output
  supplies displayed VMG and ETA; raw native ETA/TTG/VMG cannot override it.

## Limits and remaining gates

Baseline is an observed event, not reconstructed historical leg start. External
advance latency is up to polling/status observation; activation position may
precede marker by <=30s. This causes bounded time/progress uncertainty, especially
in the first minute; local fixtures cannot quantify actual vessel error. These
limits are honestly documented, not silently rebased. Endpoints implement fixed-axis
net progress, not lateral mileage or arithmetic averaging of sampled scalar speeds.
Source timestamps are checked by the plugin callback and UI, but current physical
provider provenance/positive/invalid/stale/recovery acceptance remains NOT RUN.
Owner-Go Openclaw NOT RUN; exact historical screen incident UNKNOWN. Website
numeric adoption remains unwired and materially changes semantics/provenance;
no web behavior tests rerun for evidence-only changes. No broad unrelated suite.

Software owns boundary correction and missing live proof; independent Verification
rechecks affected evidence, then Chief reconciles frozen pair and original gates.
Original ETA/VMG/release acceptance OPEN. No promotion, production operation,
deployment, switch, merge to main, npm or paid CI. Review evidence rollback:
revert this evidence commit; product rollback remains scoped source revert/rebuild.
