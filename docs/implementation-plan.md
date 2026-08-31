# Wake Logger Signal K Plugin — Implementation Plan

## 2026-08-31 refined decisions and implementation status

This is the complete original implementation plan recovered from CachyOS, with the following agreed decisions as authoritative amendments. Where an example or undecided option later in this document conflicts with this section, this section wins.

### Scope and ownership

- The eventual delivery is end-to-end: this plugin, Wake Logger pairing and device management, Mosquitto, ingestion, current state, provisional trips and private/public UI.
- This repository owns only live acquisition and resilient transport. Wake Logger owns authorization, entitlements, vessel mapping, derived wind, final trip boundaries and edits. Post-trip archival upload remains a separate system.
- Trip events from the plugin are advisory evidence. The cloud is authoritative. The first live milestone emits evidence and stores live telemetry; automatic cloud trip refinement is calibrated using real data.
- The feature uses the existing Race Analytics entitlement. All vessel crew may view private live telemetry read-only. Device management is restricted by Wake Logger's vessel-management policy, and only owners/site administrators control public sharing.
- Public tracking is owner opt-in, revocable and independently supports unlisted links and directory listing. Production rollout follows isolated validation and explicit approval.

### Representative evidence and protocol v1

Representative NMEA/DAT fixtures confirm that protocol v1 can reliably carry:

```text
lat, lon, capturedAt, receivedAt
sog_kn, cog_deg
heading_deg, heading_reference
depth_m
aws_kn, awa_deg
```

Signal K provides speed in m/s and angles in radians; the plugin converts speeds to knots and angles to degrees in `[0,360)`. Depth remains metres. True heading is preferred and magnetic fallback is labelled. Wake Logger continues deriving `tws_kn`, `twd_deg`, VMG, tack, supported speed and calculation quality rather than trusting incoming true-wind frames.

Regression fixtures cover invalid historical time anchors, out-of-range depth sentinels, non-finite values and timed-out sensors. Rate of turn, attitude, GNSS diagnostics, water temperature, speed through water, engine, electrical and tanks are outside the current telemetry profile.

Each sample receives a persistent monotonic sequence before its durable append. Identity and deduplication use `device_id + sequence`, never `vessel_id + sequence`. The authenticated device maps to its vessel server-side and a payload vessel ID is not trusted. A batch may declare `droppedThrough` to explicitly close a device-side retention/recovery gap.

### Pairing and MQTT contract

- Public pairing uses the Wake Logger HTTPS endpoint configured by the plugin.
- Non-production overrides remain local and are never committed.
- Request: `{ "code": "...", "name": "Signal K ..." }`.
- Response: `{ "device": { "id": "..." }, "credentials": { "broker_host": "...", "broker_port": 8883, "tls": true, "client_id": "...", "username": "...", "password": "...", "telemetry_profile": {} } }`.
- Topics: `wakelogger/v1/devices/<device-id>/{telemetry,state,status,events,ack,profile,profile-ack}`.
- Cloud acknowledgement: `{ "v": 1, "deviceId": "...", "ackSequence": 123, "acknowledgedAt": 1788143912200 }`.

Use MQTT 5 and QoS 1. The state and status topics are retained; telemetry and events are not. Current state publishes before ordered backlog. Broker acknowledgement alone never removes a record: the application acknowledgement follows Wake Logger's durable commit. Live and backlog duplicates are harmless under the device/sequence uniqueness constraint.

The broker uses one credential per device, required client-ID binding, default-deny ACLs and access only to that device namespace. Endpoint and certificate topology are cloud-owned and returned during pairing rather than documented here. Require TLS 1.2+, hostname validation and no insecure bypass.

### Selected implementation defaults

- Keep `OutboxStore` as the boundary. Prefer Signal K's emerging plugin-scoped Database API as a bounded delivery buffer when available, with the native-free segmented file outbox under `app.getDataDirPath()` as the portable fallback. SQLite is not shipped.
- Persist the backend selection per device. Never silently fall back from database to files because that could reuse a sequence; retain legacy files and select the database only after their pending queue is empty.
- Keep an independent outbox/sequence space per device ID. Pairing a replacement preserves the retired device's queue locally but never republishes those records under the new authenticated identity.
- Records are length-prefixed, SHA-256 checksummed and append-only, with synced appends and atomic metadata. Corrupt/incomplete tails are truncated during recovery.
- Defaults are 4 MiB segments, seven-day/250 MB retention, one-second live samples, batches up to 60 samples and a 64 KiB payload ceiling.
- Preserve newest data at a limit, report count/range of dropped samples and never crash Signal K. Restore retained current state from the outbox after restart.
- Start and stop remain safe/idempotent with empty configuration, no credentials, no DNS and no internet. Reconnect uses capped exponential backoff with jitter; authentication failures retain their distinct status and retry every five minutes with jitter so entitlement restoration recovers automatically.
- The plugin emits start/stop evidence using stable berth-cluster movement, not a moving origin, so slow marina departures are detected. MQTT disconnects never end a tracking session.

### Milestones

Version 0.2 beta implements the plugin foundation, supported-field normalization, database-preferred durable outbox, pairing contract, MQTT transport, application acknowledgements, private trip evidence, remote telemetry profiles, adaptive transport, expanded status, tests, CI and documentation. Wake Logger cloud/broker/API/UI delivery is implemented in the private Wake Logger repository. Remaining release gates are recorded in `original-plan-gap-audit.md`: target-hardware multi-day/ARM and real-vessel evidence, measured resource use, registry review and beta publication.

## 1. Purpose

Build a production-quality Signal K plugin that allows a vessel running Signal K to stream live telemetry securely and efficiently to Wake Logger.

The plugin will be distributed through the normal Signal K plugin ecosystem and should ultimately be installable from the Signal K AppStore.

The plugin is responsible only for **live vessel tracking and resilient live telemetry transport**.

It is **not responsible for post-trip or post-race data uploads**. Any separate full-resolution archival upload process is outside this repository and must remain architecturally separate.

The plugin must support worldwide vessel tracking and should not contain assumptions tied to a single country, jurisdiction, qualification system, race organisation or regulator.

---

# 2. Primary design goals

The plugin must:

1. Read selected live data from the local Signal K server.
2. Convert that data into the Wake Logger live telemetry schema.
3. Efficiently batch telemetry to minimise bandwidth.
4. Maintain a durable local outbound queue.
5. Continue operating while internet connectivity is unavailable.
6. Automatically reconnect when connectivity returns.
7. Prioritise current live state after reconnecting.
8. Drain queued historical live telemetry without overwhelming the available connection.
9. Publish telemetry over MQTT using TLS.
10. Use MQTT QoS 1.
11. prevent duplicate telemetry in Wake Logger through sequence numbers.
12. Support tracking sessions lasting minutes, hours, days or longer.
13. Detect probable trip start and trip end events.
14. Allow the Wake Logger cloud service to provision vessel credentials through a pairing process.
15. Require no inbound internet connection to the vessel.
16. Start safely even when Wake Logger credentials or internet connectivity are unavailable.
17. Be compatible with supported Signal K platforms, particularly Raspberry Pi/ARM installations.
18. Meet Signal K plugin registry and CI expectations.
19. Be fully testable without access to a real vessel.
20. Avoid unnecessary dependencies, particularly architecture-specific native dependencies.

---

# 3. High-level architecture

```text
NMEA 2000 / NMEA 0183 / other vessel sources
                    │
                    ▼
              Signal K Server
                    │
                    ▼
          signalk-wakelogger
                    │
          ┌─────────┴─────────┐
          │                   │
          ▼                   ▼
   Signal K subscriber   Trip state machine
          │
          ▼
   Telemetry normaliser
          │
          ▼
       Batcher
          │
          ▼
  Durable local outbox
          │
          ▼
    MQTT transport
          │
       TLS / QoS 1
          │
          ▼
      Internet
          │
          ▼
 Wake Logger MQTT broker
          │
          ▼
 Telemetry ingestion service
          │
     ┌────┴──────────────┐
     ▼                   ▼
Current vessel state   Historical live telemetry
```

---

# 4. Architectural boundaries

## Plugin responsibilities

The plugin owns:

- Signal K subscriptions
- telemetry sampling
- telemetry normalisation
- telemetry batching
- local sequence numbering
- local persistent buffering
- MQTT connectivity
- TLS transport
- pairing
- credential storage
- connection health
- trip-state detection
- transmission retry behaviour
- live telemetry backlog recovery
- diagnostic status reporting

## Wake Logger cloud responsibilities

The cloud owns:

- user accounts
- vessel ownership
- vessel identities
- pairing-code generation
- MQTT credential provisioning
- MQTT ACLs
- telemetry validation
- telemetry deduplication
- live vessel state
- historical live telemetry
- final trip construction
- trip editing/merging/splitting
- qualification calculations
- reporting and analytics

The plugin must never attempt to replicate Wake Logger business logic.

---

# 5. Technology choices

## Language

Use:

```text
TypeScript
Node.js
```

Signal K supports Node.js/TypeScript plugins through its Server API.

Use:

```text
@signalk/server-api
```

for Signal K types where practical.

Signal K currently documents Node.js 20 or later for plugin development.

## MQTT client

Preferred library:

```text
mqtt
```

MQTT.js supports Node.js, MQTT 5 features and QoS 1.

Configure explicitly for MQTT 5 rather than relying on library defaults.

## Durable queue

Create a storage abstraction:

```text
OutboxStore
```

Do not tightly couple the application architecture to SQLite.

Initial implementation should prioritise portability across:

- Linux x64
- Linux ARM64
- ARMv7
- Raspberry Pi
- Signal K Docker deployments
- Cerbo GX where practical

Signal K plugin testing installs packages with lifecycle scripts disabled, and native Node modules can create cross-platform packaging issues.

The implementation uses two replaceable approaches:

### Option A — Signal K Database API

Preferred when the server exposes the emerging plugin-scoped API. Use it only as a bounded write-ahead delivery queue, not as a competing history or Track API.

### Option B — file-backed append-only queue

Portable fallback.

Use:

```text
segmented append-only files
+
persistent acknowledgement cursor
+
atomic metadata files
```

Advantages:

- no native dependencies
- portable
- easy to inspect
- robust on Raspberry Pi
- simple recovery
- predictable disk usage

Do not ship a native SQLite dependency. The rest of the application interacts only through `OutboxStore`, keeping storage replaceable as Signal K's API evolves.

---

# 6. Proposed repository structure

```text
signalk-wakelogger/
│
├── src/
│   ├── index.ts
│   │
│   ├── config/
│   │   ├── schema.ts
│   │   └── defaults.ts
│   │
│   ├── signalk/
│   │   ├── subscriber.ts
│   │   ├── paths.ts
│   │   └── normaliser.ts
│   │
│   ├── telemetry/
│   │   ├── types.ts
│   │   ├── batcher.ts
│   │   ├── sampler.ts
│   │   └── encoder.ts
│   │
│   ├── transport/
│   │   ├── mqtt-client.ts
│   │   ├── reconnect.ts
│   │   └── connection-state.ts
│   │
│   ├── outbox/
│   │   ├── interface.ts
│   │   ├── file-outbox.ts
│   │   └── recovery.ts
│   │
│   ├── pairing/
│   │   ├── pairing-client.ts
│   │   ├── credentials.ts
│   │   └── identity.ts
│   │
│   ├── trips/
│   │   ├── state-machine.ts
│   │   ├── movement.ts
│   │   └── types.ts
│   │
│   ├── status/
│   │   └── status.ts
│   │
│   └── util/
│       ├── clock.ts
│       ├── backoff.ts
│       └── logger.ts
│
├── test/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   └── simulated-vessel/
│
├── assets/
│
├── docs/
│   ├── architecture.md
│   ├── telemetry-protocol.md
│   ├── trip-detection.md
│   ├── pairing.md
│   └── development.md
│
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── signalk-ci.yml
│       └── publish.yml
│
├── package.json
├── tsconfig.json
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

---

# 7. Signal K plugin lifecycle

The plugin must implement the standard Signal K plugin lifecycle:

```text
id
name
schema
start()
stop()
```

`start()` must never require a successful internet connection.

This is a critical requirement.

Valid startup states include:

```text
Not configured
Configured but not paired
Paired but offline
Paired and connecting
Connected
```

For example:

```text
Signal K starts
      ↓
Wake Logger plugin starts
      ↓
No Wake Logger credentials
      ↓
Plugin status:
"Not paired"
```

That is a successful plugin startup.

Do not throw an exception because:

- DNS fails
- Wake Logger is unavailable
- MQTT is unavailable
- credentials are absent
- vessel has no internet connection

Network connectivity is a runtime state, not a plugin lifecycle requirement.

---

# 8. Initial Signal K subscriptions

Create a central path definition file rather than scattering Signal K strings throughout the codebase.

Initial candidate paths:

```text
navigation.position
navigation.speedOverGround
navigation.courseOverGroundTrue
navigation.headingTrue
navigation.headingMagnetic

environment.depth.belowTransducer

environment.wind.speedApparent
environment.wind.angleApparent
```

Not every vessel will provide every path.

Missing data must be normal behaviour.

Do not require depth or wind information for basic tracking. Engine, battery, fuel and tank data are outside the product scope.

Minimum useful tracking dataset:

```text
position
timestamp
```

Preferred:

```text
position
SOG
COG
heading
```

---

# 9. Sampling strategy

Do not blindly forward every Signal K delta.

Implement path-specific sampling.

Suggested starting defaults:

```text
Position                    1 Hz
SOG                         1 Hz
COG                         1 Hz
Heading                     1 Hz
Depth                       1 Hz
Wind                        1 Hz
```

Sampling rates are remotely configurable through an approved, versioned Wake Logger telemetry profile.

Changes should still be captured where appropriate even when the normal sampling period has not elapsed.

---

# 10. Telemetry batching

Do not send one MQTT publication for every Signal K value.

Aggregate data into short batches.

Initial target:

```text
1 batch per second
```

A batch may contain:

```text
timestamp
sequence
position
SOG
COG
heading
RPM
depth
wind
other changed values
```

Target average bandwidth should be comfortably below:

```text
1 kB/sec per vessel
```

before TLS/TCP overhead.

Measure actual bandwidth during testing rather than relying on estimates.

---

# 11. Telemetry protocol

Create a versioned Wake Logger protocol.

Example conceptual JSON:

```json
{
  "v": 1,
  "vesselId": "vsl_xxx",
  "sequence": 184291,
  "capturedAt": 1788143912000,
  "trackingSessionId": "trk_xxx",
  "values": {
    "lat": -27.41238,
    "lon": 153.18291,
    "sog": 6.42,
    "cog": 241.3,
    "heading": 238.8
  }
}
```

During early development use JSON.

This allows:

- packet inspection
- logging
- test fixture creation
- rapid protocol changes

Do not optimise prematurely.

Create an encoder abstraction so CBOR or another compact binary encoding can be introduced later without rewriting transport logic.

---

# 12. Sequence numbers

Each vessel installation must maintain a monotonically increasing telemetry sequence.

Sequence numbers survive:

```text
plugin restart
Signal K restart
Pi reboot
MQTT reconnect
internet outage
```

Example:

```text
392001
392002
392003
...
```

Wake Logger backend should enforce conceptual uniqueness on:

```text
vessel_id + sequence
```

This makes MQTT QoS 1 duplicate delivery harmless.

The sequence must be assigned before the telemetry item enters the durable outbox.

---

# 13. Persistent outbox

Data flow:

```text
Telemetry created
      ↓
Sequence assigned
      ↓
Written durably to OutboxStore
      ↓
MQTT publish QoS 1
      ↓
Publish acknowledged
      ↓
Outbox item marked delivered
      ↓
Storage reclaimed later
```

Never use:

```text
create telemetry
→ publish
→ save only if publish fails
```

because a crash between creation and publishing could lose data.

Persist first.

Transmit second.

---

# 14. Outbox retention

The queue must have configurable limits.

Suggested initial limits:

```text
Maximum age:       7 days
Maximum disk use:  configurable
Default disk use:  250 MB
```

Actual limits should be tuned after measuring real data volumes.

When limits are reached:

1. Never crash Signal K.
2. Preserve the newest data.
3. Emit a visible warning.
4. Record dropped-data metrics.
5. Remove oldest backlog according to policy.

---

# 15. MQTT transport

Use:

```text
MQTT 5
TLS
QoS 1
```

Initial endpoint concept:

```text
mqtt.wakelogger.com:8883
```

Topic structure:

```text
wakelogger/v1/vessels/<vessel-id>/telemetry
wakelogger/v1/vessels/<vessel-id>/status
```

Potential future topic:

```text
wakelogger/v1/vessels/<vessel-id>/control
```

Do not create a separate MQTT topic for every Signal K path.

---

# 16. MQTT connection behaviour

Implement:

```text
exponential reconnect backoff
+
jitter
+
upper reconnect limit
```

Example conceptual sequence:

```text
1 sec
2 sec
4 sec
8 sec
15 sec
30 sec
60 sec
```

Avoid synchronised fleet reconnect storms after a server outage.

MQTT connectivity must expose states such as:

```text
disabled
unpaired
offline
connecting
online
degraded
```

---

# 17. Reconnection priorities

When connectivity returns after a substantial outage:

## Priority 1

Publish current vessel state immediately.

## Priority 2

Continue publishing new live telemetry.

## Priority 3

Drain historical live backlog.

Do not make users wait for hours of queued telemetry before Wake Logger receives the vessel's current location.

Backlog draining must be rate limited.

Example:

```text
live traffic always has priority

unused capacity
      ↓
backlog replay
```

---

# 18. Poor connectivity behaviour

The plugin should recognise degraded transport.

Potential signals:

```text
connection resets
slow publish acknowledgements
frequent reconnects
growing outbox depth
```

Introduce transport states:

```text
NORMAL
CONSTRAINED
OFFLINE
```

Under constrained connectivity, reduce lower-priority telemetry rates before reducing essential navigation tracking.

Priority order:

```text
1. Position
2. SOG
3. COG
4. Heading
5. Depth
6. Apparent wind
```

Do not implement complicated adaptation until basic reliable transport is working.

---

# 19. Pairing architecture

A user should not manually configure MQTT credentials.

Desired workflow:

```text
Install Wake Logger plugin
        ↓
Open Signal K Plugin Config
        ↓
Enter Wake Logger pairing code
        ↓
Plugin calls Wake Logger pairing API
        ↓
Wake Logger validates code
        ↓
Plugin receives vessel identity
and scoped credentials
        ↓
Plugin stores credentials locally
        ↓
MQTT connection begins
```

Pairing codes should:

```text
be short lived
be single use
be bound to an authorised Wake Logger account
```

The provisioning API may return:

```text
vesselId
clientId
MQTT host
MQTT port
credential/certificate
allowed protocol version
telemetry profile
```

Never place production credentials in source code.

---

# 20. MQTT authorisation

Each vessel must have unique credentials.

Broker permissions should restrict a vessel to its own namespace.

For vessel:

```text
vsl_123
```

allow:

```text
wakelogger/v1/vessels/vsl_123/*
```

deny publishing into another vessel namespace.

Credential revocation must be possible from Wake Logger.

---

# 21. Tracking sessions

Tracking sessions must be completely independent of MQTT connections.

A tracking session may last:

```text
minutes
hours
days
weeks
```

A vessel may reconnect to MQTT many times during one tracking session.

Example:

```text
Tracking session
──────────────────────────────────────────

MQTT #1 ───────X

                MQTT #2 ───X

                          MQTT #3 ─────────

Same tracking session throughout.
```

Never end a tracking session because:

```text
MQTT disconnects
internet disappears
Signal K temporarily loses a sensor
```

---

# 22. Trip detection

Implement a local state machine:

```text
STOPPED
   ↓
START_CANDIDATE
   ↓
MOVING
   ↓
STOP_CANDIDATE
   ↓
STOPPED
```

Initial proposed thresholds:

## Start candidate

Either:

```text
SOG > 1.5 knots
```

or:

```text
movement > 200 metres from stationary cluster
```

maintained for approximately:

```text
2 minutes
```

When confirmed, backdate the trip start to the first credible movement.

## Stop candidate

Require:

```text
SOG < 0.5 knots
```

and:

```text
positions remain within approximately 75 metres
```

for:

```text
15 minutes
```

When confirmed, backdate the end to the beginning of the genuine stationary period.

These values are starting hypotheses only.

They must be tuned using real vessel data.

---

# 23. Trip evidence

Trip events should record why the state machine changed.

Example:

```json
{
  "event": "trip_started",
  "effectiveAt": 1788143912000,
  "reason": {
    "distanceMovedMetres": 236,
    "movementDurationSeconds": 132,
    "sogThresholdExceeded": true
  }
}
```

This allows Wake Logger to:

- audit automatic detection
- improve algorithms
- explain boundaries
- correct incorrect trips
- tune thresholds

---

# 24. Engine information

Engine state is not subscribed or transmitted. GPS movement is the universal source, which also keeps engine-off sailing valid.

---

# 25. Time handling

Internally use:

```text
UTC
```

for all timestamps.

Never use local wall-clock time as the canonical trip timeline.

The UI may present local vessel/user time later.

Store source timestamps when supplied by Signal K.

Also retain local receipt time where useful for diagnosing delays.

---

# 26. Plugin status

The Signal K Admin UI should expose meaningful status.

Examples:

```text
Wake Logger: Not paired
Wake Logger: Connecting
Wake Logger: Connected
Wake Logger: Offline — 327 queued messages
Wake Logger: Connected — replaying backlog
Wake Logger: Authentication failed
```

Useful metrics:

```text
connection state
last successful publish
queue message count
queue disk size
oldest queued message age
current sequence
tracking state
last position timestamp
```

Never expose secrets in logs or status text.

---

# 27. Testing strategy

Testing is a first-class requirement.

## Unit tests

Cover:

```text
telemetry sampling
telemetry batching
sequence generation
outbox persistence
outbox recovery
MQTT retry logic
trip state transitions
movement calculations
configuration validation
protocol encoding
credential handling
```

## Crash tests

Simulate:

```text
process dies after queue write
process dies during transmission
Signal K restart
machine reboot
partially written queue segment
```

Data must recover safely.

## Network tests

Simulate:

```text
DNS failure
broker unavailable
TLS failure
connection reset
30-second outage
30-minute outage
24-hour outage
very slow connection
duplicate MQTT delivery
out-of-order backlog arrival
```

## Vessel simulation

Create reusable fixtures covering:

```text
stationary at berth
GPS drift at berth
slow marina departure
normal motor trip
sailing trip with engine off
brief stop
anchoring
return to berth
poor GPS
long tracking session
```

---

# 28. Signal K development testing

Agents should maintain a local Signal K development environment.

Signal K provides sample NMEA 2000 data for plugin development.

The plugin should also be linkable into a development server using `npm link`.

No agent should require access to the real vessel for routine development.

Hardware testing happens only after simulation passes.

---

# 29. Continuous integration

Create normal project CI:

```text
lint
typecheck
unit tests
build
npm audit
```

Also use Signal K's reusable plugin CI workflow.

The Signal K workflow validates plugin behaviour across supported environments including multiple architectures.

The repository should not merge changes to `main` if:

```text
build fails
tests fail
Signal K plugin CI fails
```

---

# 30. Signal K registry compatibility

The plugin should target a full Signal K registry quality score.

Registry tests currently evaluate areas including:

```text
installation
plugin loading
activation
configuration schema
automated tests
npm security audit
changelog
screenshots
core dependency freshness
```

Important:

The registry executes plugin code in a restricted environment with no network access.

Therefore:

```text
start()
```

must operate successfully when the Wake Logger cloud service cannot be reached.

---

# 31. Dependency policy

Keep runtime dependencies minimal.

Before adding a dependency, agents should check:

```text
Is it maintained?
Does it work on ARM?
Does it require postinstall scripts?
Does it compile native code?
Does it materially improve the product?
Can Node.js already do this?
```

Avoid native modules unless there is a strong reason.

Do not tightly pin Signal K core dependencies in ways that unnecessarily block current same-major releases.

---

# 32. Security requirements

Never log:

```text
passwords
private keys
access tokens
pairing secrets
full credentials
```

Use TLS certificate validation.

Do not allow:

```text
rejectUnauthorized: false
```

in production.

Validate data received from pairing APIs.

Validate plugin configuration.

Use bounded inputs.

Ensure telemetry payload size is bounded.

Include:

```text
SECURITY.md
```

with a vulnerability reporting process before public release.

---

# 33. Logging

Use Signal K's plugin logging facilities.

Log levels should conceptually include:

```text
status
debug
warning
error
```

Normal operation must not produce excessive logs.

Avoid per-second telemetry logging except in explicit debug mode.

---

# 34. Documentation

Before first public beta the repository must contain:

## README

Cover:

```text
What Wake Logger is
What the plugin does
Requirements
Installation
Pairing
How live telemetry works
Offline behaviour
Privacy/data transmitted
Troubleshooting
Development
```

## architecture.md

Explain component boundaries.

## telemetry-protocol.md

Document every protocol version and field.

## trip-detection.md

Document state machine and thresholds.

## development.md

Explain:

```text
npm install
build
test
npm link
Signal K development setup
sample data
```

---

# 35. Versioning

Use semantic versioning.

Suggested milestones:

```text
0.1.0   Signal K subscription prototype
0.2.0   MQTT transmission
0.3.0   durable offline queue
0.4.0   Wake Logger pairing
0.5.0   trip detection
0.6.0   first vessel beta
0.9.0   public release candidate
1.0.0   production release
```

Do not treat these as mandatory release numbers if implementation order changes.

---

# 36. Publishing

Eventually publish as an npm package containing:

```text
signalk-node-server-plugin
```

in its package keywords.

Add appropriate Signal K AppStore metadata including:

```text
display name
icon
screenshots
description
```

Use GitHub Actions to publish releases.

Prefer npm trusted publishing/OIDC over long-lived npm publishing tokens.

Do not manually publish production releases from developer machines.

---

# 37. Agent workstreams

The following workstreams can proceed in parallel after the initial contracts are agreed.

---

## EPIC 1 — Repository foundation

### Agent tasks

- initialise TypeScript configuration
- define linting
- define test runner
- establish directory structure
- add Signal K plugin entry point
- add package metadata
- implement empty configuration schema
- add standard CI
- add Signal K CI
- add README skeleton
- add CHANGELOG
- add licence
- add SECURITY.md

### Acceptance criteria

```text
npm ci
npm run build
npm test
```

all succeed.

Plugin loads in Signal K.

Plugin starts without configuration.

Signal K CI passes.

---

## EPIC 2 — Signal K data acquisition

### Agent tasks

- implement subscription manager wrapper
- centralise Signal K paths
- capture timestamps
- normalise vessel navigation values
- implement path-specific sampling
- handle missing paths cleanly
- build sample-data tests

### Acceptance criteria

Given simulated Signal K deltas, the plugin produces deterministic normalised telemetry.

No network connectivity is required.

---

## EPIC 3 — Telemetry protocol

### Agent tasks

- define protocol v1
- define telemetry types
- define sequence behaviour
- implement JSON encoder
- document protocol
- write compatibility tests

### Acceptance criteria

The same input always generates schema-valid protocol output.

Protocol versioning is explicit.

---

## EPIC 4 — Persistent outbox

### Agent tasks

- define `OutboxStore`
- implement file-backed queue
- add atomic writes
- implement acknowledgement cursor
- implement queue recovery
- implement disk limits
- expose queue statistics
- implement crash/restart tests

### Acceptance criteria

A simulated process restart loses no acknowledged or unacknowledged state beyond clearly documented guarantees.

Queue survives reboot/restart.

---

## EPIC 5 — MQTT transport

### Agent tasks

- implement MQTT 5 client
- implement TLS
- QoS 1 publishing
- connection state
- reconnect backoff
- jitter
- publish acknowledgement handling
- Last Will/status
- graceful shutdown
- integration tests using a local broker

### Acceptance criteria

Telemetry is removed from the outbox only after successful publication acknowledgement.

Broker outages do not crash the plugin.

---

## EPIC 6 — Reconnect and backlog recovery

### Agent tasks

- current-state priority publishing
- live-vs-backlog scheduler
- backlog throttling
- duplicate safety
- connection health metrics
- degraded-network tests

### Acceptance criteria

After a simulated one-hour outage:

1. current vessel position appears first
2. new live data continues
3. historical backlog drains afterwards
4. no telemetry sequence is lost
5. duplicate delivery is safe

---

## EPIC 7 — Pairing

### Agent tasks

- pairing API contract
- pairing-code configuration
- credential persistence
- credential replacement
- credential revocation handling
- authentication error states
- status reporting

### Acceptance criteria

A newly installed plugin can move through:

```text
unpaired
→ pairing
→ provisioned
→ connected
```

without manual MQTT configuration.

---

## EPIC 8 — Trip detection

### Agent tasks

- movement-distance calculations
- stationary cluster logic
- trip state machine
- start dwell timer
- stop dwell timer
- trip event generation
- state persistence
- simulated voyage tests

### Acceptance criteria

The simulation suite correctly distinguishes:

```text
GPS drift
real departure
temporary stop
anchoring
arrival
engine-off sailing
```

according to documented rules.

---

## EPIC 9 — Plugin UI/status

### Agent tasks

- configuration schema
- pairing input
- status messages
- queue metrics
- connection information
- basic troubleshooting feedback

### Acceptance criteria

A vessel operator can determine whether the plugin is:

```text
paired
connected
offline
buffering
replaying
faulted
```

without reading server logs.

---

## EPIC 10 — Production hardening

### Agent tasks

- dependency audit
- memory testing
- CPU testing
- long-duration testing
- storage-limit testing
- fuzz malformed input
- log review
- secret review
- platform testing
- documentation completion

### Acceptance criteria

Run simulated tracking continuously for at least several days while introducing repeated outages and restarts.

No uncontrolled queue growth.

No memory growth.

No crashes.

No credentials in logs.

---

# 38. Agent development rules

All agents working in this repository should follow these rules.

## Rule 1

Do not alter protocol contracts silently.

Changes to telemetry protocol must update:

```text
telemetry-protocol.md
tests
protocol version where required
```

## Rule 2

Do not introduce Wake Logger cloud business logic into this repository.

## Rule 3

Do not combine post-trip archival uploads with live telemetry.

## Rule 4

Internet outages are normal operating conditions, not exceptional failures.

## Rule 5

Signal K sensors and paths may disappear at any time.

## Rule 6

Never assume engine information exists.

## Rule 7

Never assume one vessel timezone.

## Rule 8

Never assume one jurisdiction.

## Rule 9

Never require inbound connectivity to the vessel.

## Rule 10

Do not introduce a native runtime dependency without demonstrating Signal K CI compatibility.

## Rule 11

Tests accompany functional changes.

## Rule 12

`start()` and `stop()` must remain safe and idempotent.

## Rule 13

Do not expose secrets.

## Rule 14

Keep bandwidth measurable and intentional.

## Rule 15

Prioritise reliability and recoverability over clever optimisation.

---

# 39. Recommended initial development sequence

Agents should not try to build everything simultaneously.

### Phase 1

```text
Repo foundation
Signal K plugin skeleton
Signal K subscriptions
Simulation fixtures
```

### Phase 2

```text
Telemetry protocol
Sampling
Batching
Sequence numbers
```

### Phase 3

```text
Persistent outbox
Crash recovery
```

### Phase 4

```text
MQTT
TLS
QoS 1
Reconnect behaviour
```

### Phase 5

```text
Wake Logger ingestion integration
Pairing
```

### Phase 6

```text
Long outage handling
Backlog scheduling
```

### Phase 7

```text
Trip detection
```

### Phase 8

```text
Real Raspberry Pi / Signal K vessel test
```

### Phase 9

```text
Public beta
Signal K registry
npm/AppStore release
```

---

# 40. First implementation milestone

The first genuinely useful milestone should be:

```text
Signal K sample NMEA 2000 data
        ↓
signalk-wakelogger
        ↓
position + SOG + COG
        ↓
1-second batches
        ↓
persistent outbox
        ↓
MQTT QoS 1
        ↓
local test broker
        ↓
test Wake Logger ingestion endpoint
```

Do not begin with:

```text
pairing UI
adaptive bandwidth
binary encoding
complex trip detection
full vessel telemetry
```

until this core pipeline works reliably.

---

# 41. Definition of first-vessel-ready

The plugin is ready for installation on the first real vessel when all of the following are true:

- Signal K CI passes.
- Plugin starts without internet.
- Plugin starts without Wake Logger credentials.
- Position/SOG/COG are captured correctly.
- Telemetry survives Signal K restart.
- Telemetry survives Pi restart.
- MQTT disconnect/reconnect works.
- A 30-minute outage produces no unintended telemetry loss.
- Current position is prioritised when connectivity returns.
- Backlog drains without blocking live telemetry.
- QoS duplicates are handled.
- Queue disk limits operate.
- No secrets appear in logs.
- CPU usage is acceptable on Raspberry Pi.
- Memory usage remains stable.
- Bandwidth usage has been measured.
- Plugin status clearly reflects connection and queue state.

---

# 42. Definition of public-release-ready

Before `1.0.0`:

- Complete README.
- Complete architecture documentation.
- Complete telemetry protocol documentation.
- Complete trip detection documentation.
- Screenshots available.
- Changelog current.
- Security policy available.
- npm audit acceptable.
- Signal K registry score reviewed.
- Signal K CI green.
- ARM testing completed.
- Real vessel testing completed.
- Multi-day session testing completed.
- Poor-connectivity testing completed.
- Wake Logger pairing operational.
- Credential revocation tested.
- MQTT ACL isolation tested.
- Upgrade from previous plugin version tested.
- Plugin uninstall/reinstall behaviour understood.
- Privacy/data-transmission documentation complete.

---

# 43. Non-goals for version 1

Do not allow scope creep into:

- full NMEA 2000 archival
- CAN-frame uploads
- historical file uploads
- chart plotting
- navigation planning
- autopilot control
- vessel control commands
- remote Signal K administration
- generic MQTT bridging
- Signal K replacement
- qualification calculations inside the plugin
- country-specific regulatory logic

Those belong elsewhere.

---

# 44. Product principle

The plugin should eventually feel almost invisible.

Ideal vessel-owner experience:

```text
Install Wake Logger
        ↓
Enter pairing code
        ↓
Connected
```

Everything else:

```text
MQTT
TLS
queue management
retries
sampling
protocol versions
outages
backlog recovery
```

should happen automatically.

The success criterion is not merely that telemetry works on perfect Wi-Fi.

The success criterion is that the vessel can move between good cellular coverage, poor coverage and no coverage for extended periods, and Wake Logger still reconstructs an accurate, ordered tracking timeline once communication becomes available again.
