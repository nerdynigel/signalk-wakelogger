# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/) and semantic versioning.

## [Unreleased]

## [0.2.0-beta.1] - 2026-09-02

### Changed

- Replaced the placeholder Signal K App Store artwork with Wake Logger's official 512 px blue-wave app icon.
- Reworked the App Store summary and README to introduce Wake Logger's live tracking, trip replay, vessel/crew workspace, environmental context and optional performance-analysis features.
- Clarified how accepted Signal K telemetry appears in Wake Logger's private and optionally shared live vessel views.
- Updated App Store publication guidance for the npm `latest` alias required by Signal K discovery during the beta period.

### Validated

- Confirmed an active production association transmitted all supported fields and received application-level durable acknowledgements with no pending queue; the synthetic Signal K source was disabled immediately after the check.

## [0.2.0-beta.0] - 2026-09-02

### Changed

- Separated npm beta publication from Raspberry Pi, real-vessel and target-hardware validation; those remain first-vessel and stable-production gates collected through the beta.

### Added

- Retained, credential-free plugin/outbox diagnostics for the Wake Logger administration dashboard.
- Database API-preferred `OutboxStore` with a portable file fallback and sequence-safe backend selection.
- Remotely managed, path-specific telemetry profiles and retained application acknowledgements.
- Adaptive `NORMAL`, `CONSTRAINED` and `OFFLINE` sampling and rate-limited live/backlog scheduling.
- Public-repository leakage checks, AppStore screenshots and beta-only trusted publishing preparation.
- Disposable real-Mosquitto CI coverage and credential-bound outbox protection against partial-state sequence resets.
- Idempotent beta-only npm release checks with exact tag/main ancestry, protected environment and trusted-publisher bootstrap documentation.
- Disposable packaged-plugin Docker testing with real Signal K NMEA 2000 playback, generated HTTPS/MQTT TLS, durable ACKs, broker outage and abrupt-restart recovery.
- Bounded retry for temporary pairing failures, explicit revoked-device status and a protected local credential-forget action that preserves retired outboxes and sequence state.

## [0.1.0] - 2026-08-31

### Added

- Signal K lifecycle, configuration and supported navigation subscriptions.
- SI normalization, validation and one-second sampling.
- Checksummed segmented outbox with durable sequences and recovery.
- MQTT 5 TLS/QoS 1 transport, current-state priority and application acknowledgements.
- HTTPS pairing, protected credential persistence, trip evidence and status metrics.
- Unit tests, CI, protocol and operational documentation.
