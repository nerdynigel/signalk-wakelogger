# Current race plan remediation

- [x] Reproduce cached identity loss on native failure/retry and stale UI.
- [x] Verify owned active route from persisted native resource without overriding foreign routes.
- [x] Show latest desired identity, activation state, named explicit action and Race Pack course/date.
- [x] Run unit, browser, and disposable Signal K lifecycle acceptance.
- [ ] Open focused PR and report evidence.

## Owner proof

At baseline d0fd308 the new unit regression fails: after old plan 16 revision 2, a failed plan 19 revision 3 write replaces cachedCourse; restart/retry returns applied/conflict instead of active. Accepted cachedCourse is a desired document, so it cannot reliably prove the native active route's previous ownership. Reading native ownership metadata and requiring its deterministic route href fixes this while retaining explicit activation for foreign routes and protecting unrelated resources at the desired route ID.

Baseline browser regression fails with header SAGS 27/09/2026 after desired SAGS 04/10/2026 · Course H arrives. The updated view prioritises desired identity, labels rejected/conflict activation and the named Activate action, displays Race Pack plan/course/start date, and preserves readiness missing-item details.

Local validation: npm run check (260 passed, one existing opt-in broker test skipped), 28 browser tests, and real disposable Signal K 2.31.1/TLS MQTT lifecycle gate. Docker gate retains an active owned old route while a synthetic unowned resource occupies the new desired ID: rejected/native_route_conflict. Removing that synthetic collision and retrying plan 19 revision 5 gives applied/active. A foreign native route with revision 6 gives applied/conflict until explicit onboard activation. Existing progress, replay, restart, local-only recording and crash/outbox recovery gates pass. Browser fixtures include plan 16 revision 2 to plan 19 revision 3, pack revision 1886, and three readiness items.

This is owner proof, not independent acceptance. The incident's exact occupied/malformed route resource was not inspected and its production provenance is unproven. Native activate returns applied/conflict for a foreign active route; native_route_conflict rejection comes from ensureResource's unrelated target-resource guard. Foreign native routes still require explicit activation; foreign resources at the deterministic target ID remain protected even from the explicit action. No production access, deploy, merge or npm publication.
