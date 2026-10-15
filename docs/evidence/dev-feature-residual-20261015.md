# THE-882 Software residual DEV proof — native ETA cases, consent, real-API tides (15 Oct 2026)

Scope: remaining Software & Protocol Engineer tranche returned by Reliability
comment `d85d055f` (run `ead20d27`). Isolated synthetic DEV only; no production,
schema, identity, broker or shared-service change. Base revision
`release/2026-w42` @ `7aba609c130c6c06cccf2e91aa15927ab07bd8d8` (Reliability
evidence commit); frozen product plugin `095bcbd9`, web `0010b20b`.

## 1. Native ETA remaining cases — PASS

`docs/evidence/dev-native-eta-cases.py` → `dev-native-eta-cases.json`
(11 observations, single-use; partial attempts 1–5 preserved honestly).
Served `leg-eta.mjs` / `course-progress.mjs` / `instruments.mjs` /
`wind-derivation.mjs` were byte-compared to local `public/` before evaluation,
and all navigation input came from real authenticated native Signal K WS
telemetry (`THE882.synthetic.eta`) on the actual plugin/endpoint readback path.

| Case | Observed (native) | Criterion proven |
| --- | --- | --- |
| `continuous-average-early/mid/late` | vmgKn 0.1534 / 0.8877 / 0.9702 leg-average over unequal gaps; each equals an independent Python recomputation of `alongLegMeters` projection to 1e-9; horizon rule respected (numeric ETA vs `ETA outside live horizon` when implied TTG > 86400 s); marker unchanged | ETA from VMG averaged over the leg, never instantaneous (injected SOG = 0); no near-zero blowout beyond the plausibility bound |
| `out-of-sync-inputs` | reason `Navigation inputs out of sync`, vmg/eta null | Skew guard natively |
| `stale-inputs` | reason `Fresh navigation inputs unavailable` | Staleness guard natively |
| `recovery-after-stale` | numeric ETA resumes (vmgKn 0.9855) | Recovery without operator action |
| `reset-provisional-suppression` | after real `/course/activate`: new `startedAt`, reason `Collecting leg average; plan speed unavailable`, no instantaneous fallback | Reset boundary + bounded-fallback suppression |
| `nonpositive-leg-average` | vmgKn -1.7977, reason `No positive leg progress` | Backing away suppresses ETA rather than producing multi-day values |
| `recovery-after-negative` | numeric ETA, marker `startedAt` unchanged (no rebase) | Recovery on the same leg |
| `invalid-position` | Signal K accepted lat 95; module returned `Navigation inputs unavailable`, vmg/eta null | Invalid native position never yields an ETA |
| `recovery-after-invalid` | valid ETA after valid fixes | Recovery |

Tracking was NOT changed by the driver: `local_only`/OFF before and after
(`trackingBefore`/`trackingAfter` in the receipt). Continuity baseline chain:
pre-restart marker → disclosed attempt resets → current marker, asserted equal
at run start.

Disclosed attempt history (driver defects found and fixed, all in the driver,
no product defect): attempt1 phase timing, attempt2 reset ordering, attempt3
continuity baseline semantics, attempt4 finish timeout, attempt5 phase input
freshness (SOG/COG). Receipts retained.

## 2. Native tracking consent + race-event behaviour — PASS

`docs/evidence/dev-tracking-consent.py` → `dev-tracking-consent.json`,
`dev-tracking-consent-post.json`. Real served plugin page, real isolated
endpoints, run-bound read-write token; native `window.confirm` modal driven
both directions:

1. baseline OFF: `aria-checked=false`, mode `Record locally`.
2. click OFF→ON, dismiss modal: **zero POST** to `/tracking`, state unchanged — cancel proven.
3. click OFF→ON, accept: exactly one POST `{uploadMode:automatic, confirmed:true, expectedUploadMode:local_only}`, state ON.
4. click ON→OFF, dismiss: still ON, still one POST — cancel proven in the other direction.
5. click ON→OFF, accept: second POST `{uploadMode:local_only, confirmed:true, expectedUploadMode:automatic}`, state OFF, `Recording locally`.
6. reload: OFF persisted; no page errors.

Race/trip event vs consent: the movement injected for the ETA proof crossed the
trip-start distance threshold and the plugin began a LOCAL synthetic recording
(`5f835fd9-cd30-45ab-bd08-454c2416e1ec`, START_CANDIDATE→STOP_CANDIDATE) while
tracking was OFF; mode stayed `local_only` throughout and the UI showed
`Recording locally`/samples saved onboard. A trip/race event therefore does
**not** silently enable uploads; uploads require the confirmed modal.

Disclosure: the confirmed-ON step uploaded the queued synthetic recording
samples to the isolated local API receiver (ACK 587→647); final state OFF.

## 3. Real API tide coverage — provider gap named, degradation PASS

`docs/evidence/dev-tide-real-api.py` → `dev-tide-real-api.json`,
`dev-tide-real-api-page.json`, screenshot `dev-tide-real-api-1365.png`.
The real served website (web `3010`) was rendered against the real isolated API
with **no mocks** (`/vessels/manage?vessel=4&tab=trips`):

- voyage 4: `tide_events` 0, `race_plan_id` 25; summary found.
- `POST /v1/voyages/4/environment-snapshots/backfill` → **502** `Failed to backfill environment data`; `.../fetch` → **502** `Failed to fetch environment data`.
- `POST /v1/race-plan/25/recalculate` → 200 with `tide_snapshot_json.source_type="unavailable"`, 0 events.
- Served page: voyage card visible, **0** tide cards, explicit `No tide summary available.`, no page errors.

Named gap (not Software-fixable in this fixture): real-provider tide ENRICHMENT
cannot be exercised here — the DEV environment snapshot provider fails 502 and
no tide-pack data exists. Served tide RENDERING against a full data shape is
already proven with routed samples in `dev-feature-proof-20261015.md`
(desktop/mobile, differential, missing state, race fallback). Enrichment proof
requires either a working provider stub or a received Race Pack; broker
publication is Reliability-owned through Chief.

Related named gap (unchanged): the numeric provisional-plan fallback
(`plan speed` branch) needs a received Race Pack (MQTT); in this fixture
`pack.available=false`, so the suppression path is proven but not the numeric
provisional value. Local analytic proof exists in the prior evidence.

## Preserved state after this tranche

- `voyage4 1e25ce14-…` complete 190/190, retained; original recordings untouched.
- Route4/plan25 and leg marker history retained; explicit reset events are recorded in the receipts.
- Tracking final `local_only`/OFF; new synthetic recording `5f835fd9…` preserved (local, self-stopping); queue currentSequence 1439, acknowledgedSequence 647, dropped 0.
- No production mint, no sudo, no destructive op, no contract change.

## Reproduce

```bash
python3 docs/evidence/dev-native-eta-cases.py        # ~6 min, single-use receipt
python3 docs/evidence/dev-tracking-consent.py        # ~1 min, single-use receipt
python3 docs/evidence/dev-tide-real-api.py           # ~1 min, single-use receipt
```
Run-bound secrets are fetched at runtime; receipts are single-use by guard.
