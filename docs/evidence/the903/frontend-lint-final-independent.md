# Corrected frozen host checkpoint — independent lint PASS, release HOLD

Independent Verification, 12 October 2026. Repository nerdynigel/wakelogger;
isolated linked checkout `.paperclip-runtime/wt-the-903-lint-accepted`, branch
`evidence/the-903-lint-accepted`, source d2da138126cc3fbc0e6dd96fc5b2cd64a1cb3f0c.
Root checkout/unrelated runtime WIP preserved. No product/test/config edits.

## Executed independent proof

Existing Node24.21.0 at /home/nigel/.nvm/versions/node/v24.21.0/bin prepended to PATH;
frontend working directory. Every final check exited0:

- `npm ci --no-audit --no-fund`: clean install PASS. Install-script approval notices
  disclosed; no approval or infrastructure changes made. Earlier deprecation/audit
  findings remain disclosed, no remediation claimed.
- `npm run lint`: zero errors/zero warnings, unchanged --max-warnings0.
- ESLint API `lintFiles(['.'])`: sorted actual set equals committed inventory207;
  exact installed9.39.1; all diagnostics zero. `calculateConfigForFile` checks module
  app/page.js and CommonJS e2e/tide-source-mocked.cjs, ten error rules/noInlineConfig.
- ESLint `lintText`: valid JSX and CommonJS clean; duplicate-key, unreachable and
  misspelled typeof probes each produce their required severity2 rule diagnostic.
- Espree ecma2022/module/JSX parse baseline dc80983 and corrected d2da138 for all
  four changed frontend files: AST equality excluding offsets/location PASS.
  First assertion runner's root-relative pathspec was mistakenly used from frontend
  cwd and stopped at file-count assertion (1 versus4); corrected `git -C .. diff
  --name-only dc80983 d2da138 -- frontend` rerun passes all four. No source changes.
- `npm run test:unit`:86 passed,0 failed,0 skipped,142.696621ms.
- `NEXT_TELEMETRY_DISABLED=1 npm run build`: webpack PASS, compile11.5s,
  static29/29. This is separate from historical Turbopack failure.
- `git diff --check dc80983 d2da138`: PASS. Correction delta exactly five obsolete
  directives removed in four files plus two evidence files. Package/lock/config
  equality against dc80983 PASS; no threshold weakening. API equality against
  accepted2dd0aa87d264d7b4b3a61dd9cd96af1c030a9698 PASS.

## Exact pair, source map and reuse

`git ls-remote origin` confirms chore/the-903-eslint and release/2026-w42-web
both d2da138126cc3fbc0e6dd96fc5b2cd64a1cb3f0c; `gh pr view81` confirms draft
PR https://github.com/nerdynigel/wakelogger/pull/81, master, same head.
Plugin `git ls-remote` and `gh pr view22 --repo nerdynigel/signalk-wakelogger`
confirm release/2026-w42 bb9d1c34c0d8d6c19ad782140ada293d76b972a6,
draft https://github.com/nerdynigel/signalk-wakelogger/pull/22, main.
Plugin eaf8bff75d03aded2cfd58bc46f73bbf63c344ff..bb9d1c3 delta reviewed:
only four ETA evidence documents; `git diff --exit-code ... -- . ':!docs'` PASS.
Therefore unchanged plugin289(+default broker skip), services/ETA73, real broker1,
lint/typecheck/build/public-guard proof in host-acceptance.md is reused with its
original source/environment bounds; no current physical-input proof inferred.

Web original0642a23145dcffc274b7f7344fadef0e9f90836a..d2da138 inventory reviewed:
three API test corrections, evidence/ETA documents, authorized frontend
manifest/lock/config and four comment-only files. API production unchanged;
API790/5skips/7passing-subtests and opt-in PDF27 at2dd0aa8 are reused explicitly
from host-final-validation.md, including actual4-page gate and overflow6 pages/
all45 cautions/repeated headers. No broad API/PDF/plugin/browser reruns.
Historical independent baseline FAIL report remains attributed and superseded
only for the corrected lint gate. Final independent frontend86/build proof above
supersedes owner-reported frontend checks on this exact source.

## Remaining gates and disposition

Bounded corrected host lint acceptance PASS; overall release HOLD / NOT SAFE TO
ACCEPT. Optional API MQTT/vendor oracles NOT RUN; historical browser/Turbopack
limitations retained. No standalone web typecheck claim. Original current-vessel/
physical-native/live negative/recovery, authenticated-owner/Openclaw/device,
Finish-to-cloud/incident/ARM/soak and owner-Go remain OPEN. Explicit web next-mark
null/freshness-reason/— must be observed in live proof; numeric native recovery
NOT RUN. Existing source procedures/live preparation in frontend-lint-correction.md
remain checkpointed plans, not executed acceptance.

Chief owns remaining reconciliation, bounded Reliability read-only serve/rollback
preflight and exact Openclaw Go request. Native Verification approval is limited to
this corrected host checkpoint; no sibling closure, switch/serve/deploy/merge/npm
release, paid CI or waiver. One evidence file delivered, no new PR. Rollback of
this evidence is scoped revert; runtime/config correction rollback remains as
recorded by Software. Remote evidence SHA is recorded in issue handback.
