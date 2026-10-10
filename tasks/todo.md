# Current race plan remediation

- [x] Reproduce cached identity loss on native failure/retry and stale UI.
- [x] Verify owned active route from persisted native resource without overriding foreign routes.
- [x] Show latest desired identity, activation state, named explicit action and Race Pack course/date.
- [x] Run unit, browser, and disposable Signal K lifecycle acceptance.
- [x] Open focused PR and report evidence (PR #16).

## Owner proof

At baseline d0fd308 the new unit regression fails: after old plan 16 revision 2, a failed plan 19 revision 3 write replaces cachedCourse; restart/retry returns applied/conflict instead of active. Accepted cachedCourse is a desired document, so it cannot reliably prove the native active route's previous ownership. Reading native ownership metadata and requiring its deterministic route href fixes this while retaining explicit activation for foreign routes and protecting unrelated resources at the desired route ID.

Baseline browser regression fails with header SAGS 27/09/2026 after desired SAGS 04/10/2026 · Course H arrives. The updated view prioritises desired identity, labels rejected/conflict activation and the named Activate action, displays Race Pack plan/course/start date, and preserves readiness missing-item details.

Local validation: npm run check (260 passed, one existing opt-in broker test skipped), 29 browser tests, and real disposable Signal K 2.31.1/TLS MQTT lifecycle gate. Docker gate retains an active owned old route while a synthetic unowned resource occupies the new desired ID: rejected/native_route_conflict. Removing that synthetic collision and retrying plan 19 revision 5 gives applied/active. A foreign native route with revision 6 gives applied/conflict until explicit onboard activation. Existing progress, replay, restart, local-only recording and crash/outbox recovery gates pass. Browser fixtures include plan 16 revision 2 to plan 19 revision 3, pack revision 1886, and three readiness items.

This is owner proof, not independent acceptance. The incident's exact occupied/malformed route resource was not inspected and its production provenance is unproven. Native activate returns applied/conflict for a foreign active route; native_route_conflict rejection comes from ensureResource's unrelated target-resource guard. Foreign native routes still require explicit activation; foreign resources at the deterministic target ID remain protected even from the explicit action. No production access, deploy, merge or npm publication.

GitHub initially passed checks and browser but exposed a Docker-runner dependency on host dist/. The fixture now uses its fixed expected native UUID; the packaged plugin still builds only inside Docker.

A newer Race Pack arriving before its desired course now supersedes the stale header using generatedAt versus desired.updatedAt and plan/course identity. It labels course delivery pending in the header, hides old route geometry/progress and disables activation of the previous plan. Matching pack startTime supplies the date for plan names without an embedded date. Service checks cover invalid/stale pack timestamps and unrelated revision counters.

# Race-day navigation resilience (10/10/2026 incident, THE-816)

- [x] Live navigation always visible in the Race tab (TWS/TWD/TWA, SOG, heading, VMG, next-mark bearing/distance) with activation rejected/conflicted, Race Pack missing or readiness not ready.
- [x] Explicit `/course/activate` replaces an unowned/malformed resource at `nativeRouteId(courseId)`; implicit sync still never clobbers foreign/unowned resources.
- [x] Ack and status classify the blocker (`occupied_target` | `malformed_target` | `foreign_active`) with the occupying resource id/name/owner when readable; additive `blocker` field preserves `status`/`revision`/`activation`/`errorCode`.
- [x] Read-only fallback progression computes bearing/distance/next-mark from cached course points; control writes stay gated on the active native route.
- [x] Readiness split into live-navigation and offline maps/forecast; offline never reads as "cannot navigate".

Owner proof (R. George, 2026-10-10): plugin 0.2.0-beta.8 on Callisto acked `{"status":"rejected","code":"native_route_conflict","activation":"inactive","revision":4}` for plan 20; explicit Activate could not clear the occupied target and the Race tab showed no navigation. This change replaces an unowned/malformed resource at our own deterministic route id only on explicit activation and keeps live nav visible regardless of activation. Not independent acceptance; production provenance of the occupying resource remains unproven.
