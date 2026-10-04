# Onboard heading and mirrored maneuver guides

- [x] Agree apparent-wind/ground-motion derivation and mirrored true-wind angle for both upwind tacks and downwind gybes.
- [x] Add independent map guide layer using fresh source sensors.
- [x] Project rays geographically from the vessel bow, with distinct styles and labels.
- [x] Verify geometry, freshness, both modes and tacks, missing-reference and browser lifecycle.
- [x] Open stacked PR #17 for review; revise the provisional guide to the agreed mirrored model.

Heading uses fresh true heading, never COG. Maneuver estimates derive ground-relative true wind FROM = apparent wind FROM vector − SOG/COG boat velocity vector, using the existing validated wind derivation. Both opposite tack and gybe bearings mirror the current true-wind angle: normalize(2 × TWD − heading). Upwind requires 20° ≤ |AWA| < 60° and 0° < |TWA| < 90°; downwind requires 100° < |TWA| < 175°. When available, the active leg must lie on the corresponding upwind/downwind side of the derived wind (strict 90° excluded).

Missing/stale/unknown GPS, heading, AWA, AWS, SOG or COG and more than 10 seconds input skew suppress the maneuver estimate; heading remains independent. Magnetic heading is not treated as true. Both rays start at the vessel bow and extend across the viewport with a 50 km projection bound. Labels say estimated at current motion with no tide/leeway correction. No navigation-control writes or automatic tack/gybe action.

Upload wording audit: local messageCount=0 says “Upload queue empty”; historicalUpload.completedAt records a local upload cohort and is not rendered as cloud trip completion. No protocol or status wording change needed.

Local owner proof: npm run check passed (260 tests, one existing opt-in broker test skipped; lint/types/build/repository checks passed). Thirty-one service checks cover analytic vectors, both mirrored tacks/gybes, true heading versus COG, reference/freshness/skew, source omission, leg gates, projection and longitude wrap. Full thirty-test Playwright suite and final focused guide lifecycle passed, with screenshots reviewed for bow-origin alignment. Shared cloud/plugin goldens (AWS 10 kn, SOG 5 kn): H/COG 330°, AWA 30° → opposite 77.587953774°; H/COG 30°, AWA 330° → 282.412046226°; H/COG 0°, AWA 150° → 319.792181278°.

GitHub guide CI was not executed: existing workflows filter pull-request base main, while this review is stacked on fix/current-plan-own-route. Browser fixtures are component evidence; the native route code remains unchanged from the parent PR. No production access, merge, deploy, npm publication or persistent vessel-stack changes.
