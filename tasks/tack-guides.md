# Onboard heading and apparent-wind tack guides

- [x] Agree true-heading and apparent-wind conventions with cloud chartplotter.
- [x] Add independent map guide layer using fresh source sensors.
- [x] Project rays geographically from the vessel bow, with distinct styles and labels.
- [x] Verify geometry, freshness, both tacks, missing-reference and browser lifecycle.
- [ ] Open stacked PR for review.

The heading ray uses true heading, never COG. The 30° opposite-tack ray uses apparent wind FROM = true heading + signed AWA; opposite bearing = apparent FROM + sign(AWA) × 30°. Close-hauled requires 20° ≤ |AWA| < 60°; an available active leg must also point within 60° of apparent wind FROM. Missing/stale/unknown GPS, heading or AWA and more than 10 seconds source skew suppress the affected ray. Magnetic heading is not treated as true. Both start at the displayed vessel bow. Rays extend across the viewport with a 50 km projection bound, and the label explains apparent wind changes after a tack. No navigation-control writes or automatic tack action.

Local owner proof: npm run check passed (260 tests, one existing opt-in broker test skipped; lint/types/build/repository check passed). Webapp service checks passed 31 cases, full Playwright suite passed 30 cases, and the final focused guide test passed after marker/bow alignment. Browser guide bearings 30° heading → 90° opposite and 90° heading → 30° opposite with apparent FROM 60°. Service tests cover north wrap (330°/+30° AWA → 030°, 030°/−30° AWA → 330°), geodesic/dateline projection, reach/head-to-wind/downwind-leg suppression, stale/unknown inputs, magnetic references and source skew. Native route logic is unchanged from the parent remediation branch; no production stack, navigation controls, deploy or publication were used.
