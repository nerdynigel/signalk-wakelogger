# Independent corrected leg-average ETA recheck

Verification & Release Engineer, reporting directly to Chief. Source checkpoint
APPROVED only; original ETA/VMG and release acceptance remain OPEN.

Reviewed nerdynigel/signalk-wakelogger release/2026-w42
b8f48d2f387587366bdffddc3d80f3063d813e83, draft PR22/main.
Executed git ls-remote origin refs/heads/release/2026-w42 and gh pr view 22
--json headRefOid,url: full remote/PR equality PASS. Isolated linked
.worktrees/THE-882-evidence, review/THE-882-eta-evidence; ordinary merge of
corrected candidate. No shared release/product edits. Product src/webapp/test
comparison with candidate empty. Existing untracked dependency symlink reused;
no installation. Node v24.21.0; Chromium viewport 1280x800, local4178, mocked inputs.

## Executed affected checks

All commands below executed independently, exit0:
- node docs/evidence/leg-average-independent-check.mjs: original published
  analytic harness PASS. Exact30 returns vmgKn30, TTG120s, numeric ETA
  2026-10-11T13:02:00.000Z. Endpoint/unequal-interval and offset baseline,
  above30 suppression, baseline age, fallback, freshness/recovery and geometry
  assertions pass. Harness SHA256 9df72dc7ef34777d7c9555bc8c0b270a42d798d42770d60f64d71c23c4055178
  equals original ede232791d7d2a0c144a5aa6ff78fd28b735874f object.
- node --test test/webapp/eta.test.mjs test/webapp/services.test.mjs:
  61 PASS, zero skips/failures. Exact30 numeric VMG/TTG/ETA; 30+1e-9,
  30.0001 and30.01 suppression; strict provisional plan30+1e-9 suppression.
  Retained stationary/drifting/negative/lateral/near-zero, disagreeing native
  ETA, continuous updates, below/at/above60s, fallback provenance,
  cached/native freshness/recovery, skew/date/24h and missing-baseline guards.
- node scripts/build-webapp.mjs: PASS.
- PLAYWRIGHT_BROWSERS_PATH=/home/nigel/.cache/ms-playwright
  PATH=/home/nigel/.nvm/versions/node/v24.21.0/bin:$PATH node
  node_modules/@playwright/test/cli.js test --config test/webapp/playwright.config.mjs
  --grep 'leg-average ETA page': 1 PASS,20.6s. Freshly generated served module
  exact30/above30 assertions; actual Race page numeric average, stale and
  nonpositive reasons, recovery, reload, native/cached and visibly provisional
  plan. Page errors empty; fixture writes empty. Browser/server exit with runner.
- git diff --check: PASS. Candidate product equality and unchanged backend
  src/test-unit/test-integration delta checks empty. Prior independent26 backend
  PASS at ac245c3300362aa170ada7d2d2828e0377905bce reused after this mapping;
  no unrelated backend or web suite rerun.

## Source/build identity and decision

webapp/leg-eta.mjs and regenerated public/leg-eta.mjs SHA256 both
f4d225c42bfb83a30017bc5bb5dd1c73741aa9e2c28feadcd217c172484e8fe4.
public/course-progress.mjs c3beb6cf8f6d9ffa18dfdc92d4c50528aaeb5aca4532e536a92c544d74c9245e;
public/app.mjs 03c00d40b3e2faae762c341a98cb75ecc42ba91843aa5b0565d21e3bd5d26c77;
public/index.html a233a0ffaec1f84f63ef509f2beaef4bf33e0656bc4cedb0cb647197358c2647.
Source diff is three normalization lines plus focused tests/evidence; only
computed speed within1e-12kn above30 normalizes. Strict plan and other guards
remain. Shared estimator still supplies both displayed leg-average VMG and ETA.
Historical failing report and raw harness retained unchanged and superseded
only for the corrected boundary result by this separate report.

## Limits and next gate

These are local synthetic/source/page checks, not physical-provider evidence.
Physical-current positive/invalid/stale/recovery and owner-Go Openclaw NOT RUN;
exact historical screen incident UNKNOWN. Observed activation latency and
<=30s baseline-position uncertainty retained from original independent report.
Website numeric adoption remains unwired; unchanged web54a332f0fb8d2cf4ee675f4685afce4f170d8b82
not retested for this plugin-only correction. Software retains missing live
implementation proof. Chief owns final-pair reconciliation/refreeze and live/Go
routing. No promotion, deployment, production operation, merge to main, npm,
paid CI or waiver. Rollback: revert evidence separately; product revert56ad09b
and regenerate assets under owner authority.
