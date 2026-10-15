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
Correction (15 Oct, after independent review): the two committed receipts are
redacted — the frontend origin is stored as `http://dev-web:3010`, and both
drivers now sanitize every persisted URL at write time (live address kept in
memory only). Technical results, evidence values and conclusions are unchanged.
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

Follow-up (same day): Reliability then applied a narrowly synthetic voyage4
environment fixture on the isolated API ([preparation](dev-fixture-reliability-20261015.md));
the positive served-website proof against that real API fixture is section 4.

Related named gap (unchanged): the numeric provisional-plan fallback
(`plan speed` branch) needs a received Race Pack (MQTT); in this fixture
`pack.available=false`, so the suppression path is proven but not the numeric
provisional value. Local analytic proof exists in the prior evidence.

## 4. Positive real-API tide fixture rendering — PASS (desktop + mobile)

`docs/evidence/dev-tide-real-api-positive.py` →
`dev-tide-real-api-positive.json`, `dev-tide-real-api-positive-page.json`,
screenshots `dev-tide-real-api-positive-1365.png` / `-390.png`. This renders the
real served website (web `3010`) against the real isolated API, **no mocks**,
while the [Reliability fixture](dev-fixture-reliability-20261015.md) is applied
(ids 2/2; synthetic, not provider-accuracy evidence).

- Real API values at render time: voyage4 `tide_state=rising`,
  start `1.1` / end `1.2` / min `1.1` / max `1.8` m, 3 tide events
  (low `0.2` 09:04:15Z, high `1.8` 12:05:55Z, low `0.2` 15:07:36Z);
  `POST /v1/race-plan/25/recalculate` → 200, `source_type=model`,
  `source=worldtides`, 4 numeric events, atlas `THE882 synthetic`.
- Served page (`/vessels/manage?vessel=4&tab=trips`), asserted at **1365×900**
  and **390×844**: `trip-tide-card` visible with `data-tide-source=voyage`,
  SVG area path + polyline visible, two `trip-tide-marker-edge` markers plus a
  `trip-tide-marker-during-high-…` marker, card text carries the real API values
  (high `1.80 m`, lows `0.20 m`, start `1.10 m`, end `1.20 m`,
  trip diff `+0.10 m`) — values, not fixed strings, are computed from the real
  API response and asserted in-page. No `trip-tide-provenance` for voyage
  source (by design; provenance text renders for race-plan fallback, proven by
  routed samples). Zero page errors, zero console errors, zero non-GET
  requests. Tracking stayed `local_only`/OFF; queue, recordings and voyage4
  tide fields unchanged before/after.

Missing → recovered transition: the missing-state served-page receipt
`dev-tide-real-api-page.json` (committed in `dad63ec`, captured while the real
API tide source was `unavailable`) shows **0** tide cards and the explicit
`No tide summary available.`; after Reliability's recorded rollback → reapply
([rollback](dev-fixture-rollback.json), [setup](dev-fixture-setup.json)) the
same served route renders the numeric card above. This is the real-API
fallback (explicit degradation, no errors) and recovery (numeric rendering
resumes) pair; the fixture transitions themselves were executed and receipted
by Reliability, the page evidence on both sides by Software.

Driver disclosure: the first execution of this driver wrote both receipts and
then failed in a post-write print (`len()` applied to an already-counted int).
The print was fixed; receipt contents were complete and are unchanged, and the
single-use guard prevents replay. No product, fixture-transition or service
operation was performed by this driver beyond one plan recalculation probe.

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
python3 docs/evidence/dev-tide-real-api-positive.py  # ~1 min, single-use receipt
```
Run-bound secrets are fetched at runtime; receipts are single-use by guard.
