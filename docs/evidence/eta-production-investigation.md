# THE-882: read-only production ETA investigation

Executed by Software, 11 October 2026 UTC, under Nigel's explicit production
read-only authorization. Historical physical-vessel records; **not current native
proof or captured screen/API responses**. Original acceptance remains OPEN.

## Identity and source

Registered plugin workspace 4de0cc0f-95fe-4135-ad51-b3e73b77de8b,
linked .worktrees/THE-884, release/2026-w42 starting
eaf8bff75d03aded2cfd58bc46f73bbf63c344ff, draft PR22.
Registered web workspace 4c588ef5-e0ec-475c-a7f6-f4501c9f4d3e,
linked .paperclip-runtime/wt-w42, release/2026-w42-web starting
c3ca12cee9c444bc1fe9016a78562ff619140a5e, draft PR81.
Origins verified as nerdynigel/signalk-wakelogger and nerdynigel/wakelogger.
Plugin clean before writes; web only pre-existing untracked frontend/node_modules.

Production checkout: e02fd1586730a4c04e9d376f73a94642512ac24b, clean.
API image ID sha256:5c12f729d835a2e687ac91554fa7885a0819bc49948436601efa04b74493b703;
frontend image ID sha256:01951b60c8ff2b1ca123be8d8a2e49814b08a9de3dd37a594b39cdca0c982b04.
Both containers created 2026-10-10T22:29:05Z.
Checkout and actual container source SHA256 agree:
- api/app/services/signalk_race_navigation.py:
  3b2c7b02972ac491b866fe8e67f211176a245f522d3a360c62cf0fd37ab55546
- frontend/app/race-plan/RacePlanClient.js:
  f2f2c2f651576982cb021bb924600f8677bab3f3575b9c2bab3c776664cc956f

Device prefix 1360831b, vessel1, reports plugin 0.2.0-beta.10 at
2026-10-11T07:53:13.431005Z. Installed plugin commit/provider identity is
UNAVAILABLE from inspected production records; version alone is not a source pin.

## Records and timing

UTC query bounds for 10–11 October AEST: [2026-10-09T14:00Z,2026-10-11T14:00Z).
Trip76: 2026-10-10T00:59Z–04:28Z, route26/plan20, 21.249nm.
Trip77: 2026-10-10T23:22:46.768Z–2026-10-11T05:11:44.581Z,
route27/plan21, 32.577nm. Tracking sessions11/12 have broader/different bounds;
session12 ends 04:56:44.442Z. Do not substitute trip bounds for tracking bounds.

Retained telemetry in the two-day window:15415 samples, earliest10 Oct05:46:55Z;
it does not cover trip76's race window. Trip77-window query returned14654 rows,
all packet timestamp_quality=source, SOG0.019438–8.086393kn,
stored VMG -7.377429–6.695800kn. **Stored wind VMG is not VMG to the waypoint**:
the deployed cloud computes target VMG from SOG*cos(COG-bearing).
Individual position/SOG/COG native envelopes/timestamps are absent from these
rows: raw_payload is null(811) or an object with recording metadata only(14604).
Delivery delay over session12 ranges0.274391s–3h50m21.946448s.
A source packet timestamp cannot establish individual sensor freshness.

Track-point counts (SOG speed bins, not validated maneuver labels):
trip76:14742 points,442 below0.1kn,30 between0.1–1kn,13384 at least4kn;
trip77:14604 points,384/17/13039 respectively.
Slow/drift-speed/normal-speed records exist; no independent stationary or
mid-tack annotation is established.

Twelve onboard plan snapshots1–12 for trip77, generated23:43:38Z–05:05:10Z:
all finish on11 Oct03:46–05:57Z, remaining3150–14564s.
Largest retained leg duration3210s; all midpoint dates stay10–11 October.
Saved plan20/21 totals4.586h/4.389h; no multi-day leg dates.
No retained snapshot directly records the reported multi-day screen symptom.

## Actual-source local reproduction and comparison

A bounded private projection contains14210 accepted samples within session12,
coordinates plus SOG/COG and source/receive times, and plan21's first target.
Projection SHA256:
32cc633d3a7fdf3008cc47690f0c3399d836b3e95719a268c8ac4c0b3b860746.
It stays mode0600 in run scratch and is not published. Published JSON contains
only scalar derived distances/relative angles/speeds/times and its hash.

Deployed cloud race_navigation_payload, signalk_race_navigation.py:866,
uses captured_at + distance_nm/target_vmg hours whenever target_vmg>0.1,
without a duration limit. Deployed geometry rounds bearing to0.1deg and
distance to0.001nm. Reconstruction uses those exact git-source functions.

Session12's retained cloud target index is1; no automatic advance audit for
sessions11/12. Under that conditional target:
- sample100246,23:22:56Z:3.391nm,2.235421kn SOG,
  relative angle-86.921445deg, target VMG0.1200534436kn:
  28.245754h, ETA12 Oct03:37:40Z.
- sample114640,04:56:16Z:3.388nm,target VMG0.1356132994kn:
  24.982800h, ETA12 Oct05:55:14Z.
- sample102287,00:00:56Z:1.8nm,SOG3.771058kn,
  relative angle-89.88418deg,target VMG0.0076229636kn:
  unbounded division gives236.128637h. Cloud's existing0.1kn floor rejects
  this case; it is conditional support for the previously confirmed unbounded
  closing-speed failure, **not proof of the onboard native/cached output**.

Important attribution limits: sample100246 predates plan association23:24:49Z;
sample114640 arrived05:14:14Z, after tracking ended. Neither proves a live
cursor response/browser display. Final cursor and absent automatic audit do
not establish all earlier/manual cursor values. Native calculation envelopes,
onboard exact provider/route cursor and owner screen/time are not retained.
Thus the source defect is reproduced with historical scalar inputs, but the
exact observed incident root cause remains UNKNOWN.

Cloud index1 versus onboard active legs1→3→4→7 is a confirmed retained-state
discrepancy, not proof of the ETA surface. Chief should reconcile this with the
existing progress/distance work; no new product correction in this tranche.

Candidate web at c3ca12c fails closed with eta=None because sensor freshness
provenance is unavailable. Actual-source AST reproduction checks both old and
candidate expressions: two >24h cases, normal0.411208h, and low-VMG rejection.
PASS4 cases; normal cloud ETA also becomes unavailable intentionally.
Plugin candidate at eaf8bff retains per-input freshness, >0.1kn closing speed
and24h live horizon. Prior independent fixture/native replay tests remain
accepted at their documented pins; not rerun or relabelled current-vessel proof.
Valid multi-day forecast plans remain supported.

## Commands, validation, scope and next owner

Executed read-only SSH: git rev-parse HEAD/status, docker ps/image identity,
field-whitelisted source reads/hash checks, and docker exec DB psql -X queries.
Each DB query used BEGIN READ ONLY; SET LOCAL statement_timeout='15s'; SELECT;
ROLLBACK. No logs, credentials/config dumps, production writes or replay.
Repro: python3 docs/evidence/eta-production-repro.py /path/to/wakelogger
requires both named git objects, fetched with git fetch origin <deployed SHA>.
PASS exit0. Harness reads actual source expressions, not a duplicated ETA formula.
Selected geometry/source constants verified; JSON projections omit positions.

Two exploratory SQL calls failed (json_object_keys on jsonb/scalar); corrected
type-aware SELECTs passed. Initial remote shell quoting failed before execution;
corrected quoting passed. Prod rg was unavailable; git/grep used. These failures
are not reported as successful checks.
Publication checks: Python AST parse, JSON parse, mirrored-file byte comparisons,
scoped staged/committed git diff --check; remote and PR heads recorded on issue.

| Acceptance | Outcome |
| --- | --- |
| Exact cause / observed values | Source flaw reproduced using historical scalars; screen-level attribution UNKNOWN |
| Representative correctness/fallback | Prior accepted fixture QA reused; four scalar source comparisons PASS; physical-current native proof NOT RUN |
| Regression | Prior accepted independent regressions reused; minimal historical reproduction published |
| Openclaw | Owner-Go frozen acceptance NOT RUN |

Return to native Chief review, then focused independent evidence review.
Chief owns deciding how the retained cursor discrepancy fits existing work and
reconciling evidence gaps; no new Board question or invented source endpoint.
Software retains missing native proof. Original task/release acceptance OPEN;
no promotion, deployment, switch, merge, npm publication or paid CI.
Rollback: scoped documentation/harness revert only; no production change/migration.
