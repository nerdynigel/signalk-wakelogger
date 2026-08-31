# Contributing

Create a focused branch and include tests with functional changes. Run `npm run check` before opening a pull request. Keep live telemetry separate from post-trip archival uploads and Wake Logger cloud business logic.

Do not change protocol contracts silently: update tests and `docs/telemetry-protocol.md`, and increment the protocol version for incompatible changes. Keep `start()` and `stop()` idempotent, assume internet outages and missing sensors are normal, use UTC internally, and avoid native runtime dependencies.
