# Validation evidence

Automated checks cover lifecycle startup without configuration/network, supported-path normalization, managed profiles, adaptive modes, MQTT scheduling, application acknowledgements, file/database outbox restart continuity, corrupt file-tail repair, retention gaps and sequence-safe backend selection. Accelerated release scenarios cover a 24-hour file-outbox outage with restart and partial application ACK, a three-day NORMAL/OFFLINE/CONSTRAINED sampling timeline, and conversion of the earlier telemetry-profile shape.

A disposable Mosquitto 2 CI job exercises the real MQTT.js network path independently of Wake Logger infrastructure. It verifies MQTT 5/QoS 1 publication, retained current-state priority, ordered backlog delivery and removal only after an application ACK delivered through the broker. TLS certificate and scoped-ACL enforcement remain covered in the private cloud integration suite and must be repeated against the release environment.

On 2026-09-01 the rewritten pull-request commit passed normal CI on Node.js 20/22 and the Signal K reusable matrix on Linux x64, Linux ARM64, macOS and Windows with Node.js 22/24, plus ARMv7/Cerbo emulation on Node.js 20. The integration matrix installed, enabled and started the packaged plugin in Signal K Server latest on Node.js 22/24. This is portable package evidence, not a substitute for resource measurements on the target vessel hardware.

The 2026-09-01 official Signal K plugin-registry harness preflight reported `loads`, `activates`, `activatesWithoutConfig` and `hasSchema` as true, with no provider requirement, error messages or unstubbed API accesses. Together with the lifecycle-script-free install, passing source tests, clean runtime audit, packaged changelog and screenshots, the unpublished package satisfies the current 100-point criteria in preflight. Only a published npm version can receive an authoritative registry score and AppStore listing.

An npm 11 release dry-run executed the real `prepublishOnly` guard and complete check, then produced an 80-file, 69.2 kB beta tarball with public access and the `beta` dist-tag. A separate negative invocation confirmed the guard rejects `latest`. No package, tag or release was published.

`npm run measure:protocol` encodes a synthetic 24-hour, 1 Hz stream with every supported optional field. It counts normal online application payloads: one retained state and one single-sample telemetry batch each second, plus a representative status document every ten seconds. MQTT/TCP/TLS overhead and storage/Signal K resource use are intentionally excluded. The checked target is below 1 KiB/s before transport overhead.

The benchmark is reproducible, but development-host CPU time and RSS are not vessel hardware evidence. Record release-candidate results here only after running the packaged plugin on the target Signal K ARM host:

The 2026-08-31 Node.js 20 x64 protocol run encoded 86,400 seconds in 1.45 seconds and measured 340 bytes per full sample and 780 application bytes/second for normal online traffic. A checksummed file record is approximately 376 bytes, or 31.0 MiB for a 24-hour 1 Hz worst-case queue. Process RSS was about 32 MiB during this encoding-only run. These values pass the pre-transport bandwidth target but are not full-plugin or ARM measurements.

A 2026-09-01 Node.js 22 x64 accelerated production file-outbox run wrote and synced 300 full samples in 1.34 seconds. It measured 339.84 disk bytes per sample, a 28.0 MiB/day projection, 970 ms user CPU, 147 ms system CPU and 37.29 MiB peak process RSS. This development-host stress evidence confirms the queue-size estimate and provides a regression baseline; it is neither real-time operation nor ARM evidence.

| Evidence | Development gate | First-vessel gate |
|---|---|---|
| Protocol application bytes | Automated 24-hour encoding model | Capture actual MQTT/TLS bytes during normal and replay traffic |
| CPU and memory | CI regression/no leak checks | Multi-day process metrics on target ARM host |
| Outbox disk and writes | Bounded/corruption unit tests | 24-hour offline queue growth and disk-write measurement |
| Reconnect/replay | Deterministic scheduler and real-broker integration | Poor-link and 30-minute/24-hour outage scenarios |
| Install/upgrade | npm package dry run and lifecycle CI | Install, version upgrade, reboot and uninstall/reinstall on target |

Do not mark ARM or real-vessel rows complete using x64 development-host results.

For repeatable target-host collection, build the exact release commit and run `npm run measure:outbox -- 3600` as an initial accelerated synced-write comparison, then run the installed plugin in real time for the required outage. Archive the JSON output with the commit, device model, storage medium and Signal K/Node versions. The stress tool uses production file-outbox code but does not exercise Signal K subscriptions, MQTT/TLS, scheduling or Database API storage, so it cannot by itself satisfy the hardware gate.
