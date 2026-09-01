# Original plan gap audit

This audit compares the implementation with the original 44-section implementation plan. “Implemented” means code and automated coverage exist; it does not substitute for hardware or fleet evidence.

| Original plan area | Status | Evidence or remaining gate |
|---|---|---|
| Purpose, scope and cloud/plugin boundary | Implemented | Live transport only; no archive upload, jurisdiction logic, cloud business rules or Signal K Track API provider. |
| TypeScript plugin lifecycle and offline startup | Implemented | Idempotent lifecycle and unpaired/offline integration test. |
| Signal K acquisition and normalization | Implemented for approved scope | Position/time, SOG, COG, true/magnetic heading, depth and apparent wind. Machinery, battery and tank data were removed by product decision. |
| Path sampling and remote profiles | Implemented | Versioned per-path periods for all three network modes; approved cloud profiles are persisted and acknowledged. |
| JSON protocol, batching and persistent sequence | Implemented | Protocol v1, bounded payloads, durable sequence assignment and cloud deduplication/ACK contract. |
| Durable outbox and retention | Implemented | Database API-preferred abstraction, native-free file fallback, crash-tail recovery, bounds, explicit sequence gaps and credential-bound backend selection that rejects partial-state sequence resets. Real released Database API compatibility remains an upstream availability gate. |
| MQTT 5, TLS, QoS 1 and ACL isolation | Implemented | Verified TLS, scoped topics, Last Will, reconnect jitter and app-level durable ACK. Disposable real-Mosquitto CI and the packaged Signal K Docker scenario verify TLS transport and crash recovery; release-environment ACL isolation remains a release-candidate gate. |
| Reconnect priority and constrained transport | Implemented | Retained current state, live sample priority, four bounded in-flight backlog batches, byte-rate limits and ACK/reconnect health modes. |
| Pairing and credential handling | Implemented | Short-lived single-use pairing, bounded retry, per-device credentials, protected storage, transactional replacement, explicit revocation status and an admin-only local forget action that preserves retired outboxes/sequences. |
| Tracking and trip evidence | Implemented within Wake Logger protocol | Persistent local evidence state; cloud remains authoritative. Evidence never creates a competing Signal K track service. |
| Status and cloud operations | Implemented | Queue, disk, age, drops, backend, mode, ACK latency, reconnect and profile revision metrics. |
| Unit, crash and integration testing | Implemented; hardware soak remains | Automated normalization, file/database outbox, corruption, lifecycle, real-broker transport, profile/adaptive, accelerated 24-hour restart/ACK recovery, three-day sampling and legacy-profile upgrade tests exist. A packaged Docker scenario adds real Signal K sample input, verified HTTPS/MQTT TLS, broker outage, `SIGKILL` and volume recovery. The extended outage and upgrade matrix must still run on target hardware. |
| Signal K CI and registry preparation | Implemented and passing | Normal Node 20/22 CI and the reusable Signal K matrix pass on Linux x64, Linux ARM64, ARMv7/Cerbo emulation, macOS and Windows. Signal K Server latest installs, enables and starts the packaged plugin on Node 22/24. The official registry harness preflight loads and activates it without configuration or unstubbed API use; install/tests/audit/changelog/screenshots meet the current 100-point criteria. |
| Bandwidth, CPU and memory validation | External evidence pending | Measure on the target Raspberry Pi/ARM installation under live, outage and replay workloads; do not infer hardware results from development hosts. |
| Raspberry Pi/ARM and real-vessel test | External evidence pending | Required before first-vessel and stable-production sign-off, but not for an npm beta. The beta is the field-validation channel. Hardware targets are intentionally not embedded in this public repository. |
| npm/AppStore publication | Beta published and discoverable | `0.2.0-beta.0` is public on npm, installs from the registry, appears in Signal K's keyword search and has an authoritative 100/100 registry score. The OIDC workflow uses an exact version tag, main ancestry, Node 24/npm 12 and the `beta` dist-tag. Until a stable release exists, the package owner moves npm's `latest` alias interactively to each vetted beta because Signal K uses it for new App Store discovery. |

## npm beta gate

- Normal CI and the Signal K reusable plugin matrix pass on the exact `main` commit.
- The packaged Signal K/TLS/MQTT Docker recovery scenario passes on that commit.
- The installed-package audit, package contents, metadata, changelog and public-repository scan pass.
- The release uses a prerelease version and npm's `beta` dist-tag.

Raspberry Pi, real-vessel, soak and target-hardware resource measurements are explicitly outside this publication gate. They remain product-readiness evidence and can be collected from the published beta.

## First-vessel blockers

- Repeat the green normal and reusable Signal K matrices against the exact release-candidate commit after any further code change.
- Repeat the packaged TLS broker/ingestion scenario on the exact release-candidate commit and release environment.
- Run restart, 30-minute outage and constrained-link scenarios on the intended Signal K host.
- Record bandwidth, CPU, memory and queue disk results on that host.
- Verify the documented install, upgrade and full-data-removal/re-pair semantics on the target host; partial credential-only restoration is rejected by design.

## Stable public-release blockers

- Complete multi-day poor-connectivity and upgrade soak evidence.
- Complete real-vessel and ARM evidence.
- Confirm the authoritative Signal K registry score and rendered screenshots after the first npm beta becomes discoverable in the actual AppStore.
- Test credential revocation and broker ACL isolation in the release environment.
- Agree the stable-release gate; the current workflow deliberately publishes beta tags only.
