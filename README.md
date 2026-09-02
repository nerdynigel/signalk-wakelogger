# Wake Logger for Signal K

[Wake Logger](https://wakelogger.com/) turns your vessel's Signal K data into a private live view and a trip history you can return to after the voyage. Owners and authorised crew can see where the vessel is, review where it went, and make sense of the journey using the navigation data already available on board.

The plugin is built for real marine connectivity. It stores each sample in a durable local outbox before transmission, sends the current position first when a connection returns, and keeps historical data queued until Wake Logger confirms it is safely stored.

## What it gives you

- **See the vessel's latest position.** Wake Logger presents the accepted Signal K feed in a private, read-only live view for the vessel's authorised crew.
- **Keep the story when mobile coverage drops.** Telemetry waits safely on the Signal K server and resumes automatically, so an ordinary internet outage does not become a gap in the trip.
- **Review more than a line on a map.** Trips can include speed over ground, course, heading, depth and apparent wind when the vessel supplies them.
- **Connect without exposing the vessel.** Pair with a single-use code; no inbound internet connection or manually managed MQTT credentials are required.
- **Keep access under the owner's control.** Wake Logger vessel roles and sharing settings decide who can see the live view and trip history.

Wake Logger can add trip photos, historical weather and tide context, private vessel and crew workspaces, and optional sailing-performance analysis where available. Features depend on the vessel's Wake Logger access, plan and sensors. [Explore Wake Logger](https://wakelogger.com/) to see the wider platform.

This repository handles resilient live telemetry transport only. It does not upload full-resolution NMEA archives, control vessel equipment, replace a navigation display, or implement Wake Logger's account and trip-management logic.

## Requirements

- Signal K Server with Node.js 20 or newer
- An eligible Wake Logger vessel and a single-use pairing code
- Outbound HTTPS for pairing and outbound MQTT over TLS on port 8883

No inbound vessel connection is required. The plugin starts successfully when unpaired, offline, or when Wake Logger is unavailable.

## Install and pair

Install `signalk-wakelogger` from the Signal K AppStore, then open **Server → Plugin Config → Wake Logger**. Generate a pairing code in the Wake Logger vessel settings, enter it in the plugin configuration, and save. The public Wake Logger pairing endpoint is configured by default; non-production overrides must never be committed to this repository.

The pairing code is single-use. Temporary pairing-service failures are retried up to six times with bounded exponential delays while the code remains usable; an invalid or expired code stops immediately and requires a fresh code. MQTT credentials are returned once and stored with owner-only filesystem permissions under the plugin data directory. They never appear in normal logs or status messages.

Use Wake Logger's **Replace device** workflow to move to another Signal K installation: the current association remains active until the replacement is fully provisioned. **Revoke association** stops the old device immediately without deleting its telemetry history. New pairings include a device-scoped status credential, allowing the plugin to report `Device revoked — enter a new pairing code` instead of a generic authentication error.

## Telemetry and privacy

Version 1 sends position and source time, with SOG, COG, heading, depth and apparent wind when supplied by the vessel. It does not collect battery, fuel, engine temperature or other machinery data. Signal K SI values are converted to Wake Logger's documented units. Missing optional sensors are normal. Wake Logger derives true wind, VMG and final trip boundaries in the cloud.

The plugin does not decide who can see vessel data. Private crew access and any owner-controlled public live-sharing option are enforced by Wake Logger.

## Live vessel tracking

After the first accepted position arrives, the vessel's **Signal K Live** panel in Wake Logger shows its latest position on a map together with SOG, COG, heading, depth and apparent wind when those values are available. The display refreshes as new telemetry arrives; missing optional sensors are shown as unavailable rather than preventing position tracking.

The private live panel is read-only for vessel crew. Device pairing and management require the appropriate vessel role, while public live sharing is off by default and remains under the vessel owner's control. Live telemetry is for situational awareness and trip logging, not as a certified navigation display.

## From live data to useful trips

Signal K supplies the onboard observations; this plugin delivers them reliably; Wake Logger turns accepted reports into a view people can use. The App Store screenshots show the resulting live vessel and route-review experiences first, followed by the Signal K connection and pairing screens. Wake Logger features beyond live telemetry remain cloud features and may depend on the vessel's plan.

## Offline operation

The default queue retains up to seven days or 250 MB. Records have persistent device-scoped sequence numbers and checksums. MQTT broker acknowledgement is not enough to remove a record: Wake Logger must acknowledge that the database commit completed. If a configured limit is reached, the oldest backlog is discarded, the newest data is preserved, and the dropped count is shown in plugin status.

Useful status examples include `Not paired`, `connecting`, `online`, `offline`, `degraded`, queue count/size, and dropped-record count. Enable telemetry debug logging only while troubleshooting; it does not log payloads or secrets.

An authenticated Signal K administrator can call `POST /plugins/signalk-wakelogger/forget-credentials` to forget the local cloud credential before entering a fresh pairing code. This intentionally preserves the installation identity, consumed-code fingerprint, retired device outboxes, sequence records and diagnostics; it does not revoke the cloud association, so revoke it in Wake Logger as well when retiring a device. A forgotten pairing code must be replaced with a new one.

Wake Logger administrators maintain approved telemetry profiles. Vessel Owners and First Mates can select one; other crew can see the selection but cannot change it. Navigation stays at its configured priority while depth and apparent wind can slow under constrained or offline conditions. Profile revisions and application results are visible to Wake Logger operations.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run test:docker
```

The Docker test builds the exact local npm tarball and installs it in a pinned official Signal K image. It plays Signal K's sample NMEA 2000 stream through verified HTTPS pairing and TLS MQTT, then proves durable acknowledgement, current-state priority, offline buffering and recovery after an abrupt Signal K stop. All certificates, credentials, broker data and volumes are disposable and local to the test stack.

See the complete [refined implementation plan](docs/implementation-plan.md), [original-plan gap audit](docs/original-plan-gap-audit.md), [validation evidence](docs/validation.md), [development](docs/development.md), [release process](docs/release.md), [architecture](docs/architecture.md), [protocol](docs/telemetry-protocol.md), [pairing](docs/pairing.md), and [trip detection](docs/trip-detection.md). Security issues should follow [SECURITY.md](SECURITY.md).
