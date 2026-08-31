# Wake Logger for Signal K

Wake Logger streams a vessel's live navigation, apparent wind and depth data from Signal K to Wake Logger. It is designed for intermittent marine internet connections: every sample is written to a durable local outbox before transmission, current position takes priority after reconnect, and historical data remains queued until Wake Logger durably acknowledges it.

This repository handles live telemetry only. It does not upload full-resolution NMEA archives, control vessel equipment or implement Wake Logger account and trip-editing business logic.

## Requirements

- Signal K Server with Node.js 20 or newer
- An eligible Wake Logger vessel and a single-use pairing code
- Outbound HTTPS for pairing and outbound MQTT over TLS on port 8883

No inbound vessel connection is required. The plugin starts successfully when unpaired, offline, or when Wake Logger is unavailable.

## Install and pair

Install `signalk-wakelogger` from the Signal K AppStore, then open **Server → Plugin Config → Wake Logger**. Generate a pairing code in the Wake Logger vessel settings, enter it in the plugin configuration, and save. The public Wake Logger pairing endpoint is configured by default; non-production overrides must never be committed to this repository.

The pairing code is single-use. MQTT credentials are returned once and stored with owner-only filesystem permissions under the plugin data directory. They never appear in normal logs or status messages.

## Telemetry and privacy

Version 1 sends position and source time, with SOG, COG, heading, depth and apparent wind when supplied by the vessel. It does not collect battery, fuel, engine temperature or other machinery data. Signal K SI values are converted to Wake Logger's documented units. Missing optional sensors are normal. Wake Logger derives true wind, VMG and final trip boundaries in the cloud.

The plugin does not decide who can see vessel data. Private crew access and any owner-controlled public live-sharing option are enforced by Wake Logger.

## Offline operation

The default queue retains up to seven days or 250 MB. Records have persistent device-scoped sequence numbers and checksums. MQTT broker acknowledgement is not enough to remove a record: Wake Logger must acknowledge that the database commit completed. If a configured limit is reached, the oldest backlog is discarded, the newest data is preserved, and the dropped count is shown in plugin status.

Useful status examples include `Not paired`, `connecting`, `online`, `offline`, `degraded`, queue count/size, and dropped-record count. Enable telemetry debug logging only while troubleshooting; it does not log payloads or secrets.

Wake Logger administrators maintain approved telemetry profiles. Vessel Owners and First Mates can select one; other crew can see the selection but cannot change it. Navigation stays at its configured priority while depth and apparent wind can slow under constrained or offline conditions. Profile revisions and application results are visible to Wake Logger operations.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

See the complete [refined implementation plan](docs/implementation-plan.md), [original-plan gap audit](docs/original-plan-gap-audit.md), [validation evidence](docs/validation.md), [development](docs/development.md), [release process](docs/release.md), [architecture](docs/architecture.md), [protocol](docs/telemetry-protocol.md), [pairing](docs/pairing.md), and [trip detection](docs/trip-detection.md). Security issues should follow [SECURITY.md](SECURITY.md).
