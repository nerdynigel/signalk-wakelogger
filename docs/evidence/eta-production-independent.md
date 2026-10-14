# Independent production-evidence review — THE-882

Verification & Release Engineer, 11 October 2026 UTC. APPROVE this focused evidence stage only; original ETA/release acceptance OPEN.

## Frozen identity and executed validation

Repository nerdynigel/signalk-wakelogger, release/2026-w42 be993b01dd29ddd67b03a06122452f2a2bf7e09f, draft PR22/main; nerdynigel/wakelogger, release/2026-w42-web 3b1ccc208360212a22e8695160bf8d86868176b2, draft PR81/master. Executed git ls-remote origin refs/heads/<branch> and gh pr view 22/81 --json url,headRefOid,baseRefName,isDraft in the respective repositories: exact remote/PR equality PASS, exit0. Plugin root and existing review/THE-882-eta-evidence worktree clean before evidence edit; root unrelated branch preserved. No release writes.

Executed python3 .worktrees/THE-884/docs/evidence/eta-production-repro.py ../wakelogger: PASS4, exit0. Inspected actual deployed race_navigation_payload AST/expression and geometry functions at e02fd1586730a4c04e9d376f73a94642512ac24b. SOG knots times cosine of relative angle in degrees produces target VMG knots; nautical miles divided by knots produces hours. Deployed bearing rounds to0.1 degrees and distance to0.001nm. UTC-aware captured times produce the documented ISO dates; no timezone/epoch error demonstrated.

Independently recomputed git-object SHA256: deployed navigation 3b2c7b02972ac491b866fe8e67f211176a245f522d3a360c62cf0fd37ab55546; RacePlanClient f2f2c2f651576982cb021bb924600f8677bab3f3575b9c2bab3c776664cc956f. Both match report. Candidate navigation source byte equality between labelled c3ca12cee9c444bc1fe9016a78562ff619140a5e and delivered web pin PASS. Three production evidence files byte-identical across repositories PASS. git diff --check eaf8bff be993b0 (plugin) and c3ca12c 3b1ccc2 (web): PASS exit0.

## Findings and attribution

Historical scalars reproduce 28.245754h and24.982800h deployed cloud calculations; normal sample0.411208h. Candidate eta expression is None in all four cases. Conditional236.128637h division is rejected by deployed cloud's existing0.1kn floor, so it is not an observed cloud/onboard response. Harness evaluates the selected expression only, not full DB/API behavior; four checks do not certify freshness, navigation payload selection or recovery.

The two long examples are explicitly conditional on target1: first predates plan association; second arrives after tracking ended. Normal example also arrives late (05:11:56Z versus capture03:31:21Z). Source packet timestamp does not prove individual position/SOG/COG freshness. Stored wind VMG is not waypoint closing VMG. Retained snapshot durations/finish dates reported within hours do not capture the owner's multi-day screen. Exact incident attribution remains UNKNOWN. No raw database/projection or production runtime independently re-queried here: counts, snapshot contents, private geometry projection and container-runtime identity remain Software-collected evidence, with source hashes independently corroborated. Projection hash alone cannot certify those private contents.

Cursor discrepancy does not establish a new propagation defect. Deployed signalk_race_navigation.py initialises cloud target1 on association (line469); update_waypoint_progress advances it from qualifying position geometry and writes automatic audit (line819). Deployed signalk_live.py lines298–315 independently handles previous/next/reset and conditionally queues a device course. Thus absence of automatic audit cannot exclude manual cursor history; final target1 cannot establish the cursor for earlier samples. Onboard active-leg snapshots and cloud tracking state are distinct observations. Existing THE-881 reconciliation remains accepted within its original local scope; no speculative auto-advance fix or reopening of THE-890 distance evidence justified.

Published projection contains scalar distance/relative angle/speed/time and hash, no coordinates, credentials or native provider envelopes. Representative speed bins cannot identify stationary/mid-tack maneuvers. Historical data cannot be relabelled physically-current native proof.

## Disposition and remaining gates

No blocking defect found in this evidence tranche's labelled conclusions. Prior unchanged independent behavior QA reused at its recorded pins; no broad rerun. Physical-current native positive/invalid/stale/recovery proof and owner-Go frozen Openclaw NOT RUN. Software retains missing behavior proof; Chief reconciles original acceptance and release holds and integrates this report if needed. No candidate promotion or production operations. Evidence-only rollback: scoped revert of this report. Failed exploratory checks in this review: python unavailable (used python3); guessed lib/RaceNavigationService.js path absent (located src/race files instead); no acceptance check masked.
