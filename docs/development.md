# Development

Use Node.js 20 or newer:

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
npm run measure:protocol
npm run measure:outbox -- 300
```

## Docker end-to-end test

Docker Engine with Compose v2 can run the packaged plugin in a complete disposable stack:

```sh
npm run test:docker
```

The command:

1. Builds the local source into an npm tarball and installs that tarball in a pinned official Signal K image.
2. Generates a short-lived local certificate authority at runtime; no private key is committed.
3. Starts a verified HTTPS pairing/ACK service and TLS-only Mosquitto broker.
4. Starts Signal K with its synthesized NMEA 2000 stream and the normal production plugin configuration path.
5. Verifies pairing, every approved navigation/depth/apparent-wind field supplied by the sample, MQTT 5/QoS 1, application acknowledgements and current-state-before-backlog ordering.
6. Stops the broker, allows the durable queue to grow, kills Signal K with `SIGKILL`, and proves the queued sequences recover after both services return.
7. Waits for the application-acknowledged queue to drain, prints one-shot container CPU/memory/network statistics, and removes the isolated containers, network and volumes.

Set `WAKELOGGER_DOCKER_KEEP=1` to retain a failed or successful stack for inspection. The output identifies its unique Compose project name; remove only that named project when finished. `SIGNALK_IMAGE` may override the pinned multi-architecture image for an explicit server-version test, and Docker's normal `DOCKER_DEFAULT_PLATFORM` setting can select an emulated platform. Emulation remains portability evidence, not physical ARM performance evidence.

This harness deliberately contains no production or non-production Wake Logger endpoint. Its pairing code, device identity and credentials are fixed disposable fixture values, the broker accepts clients only inside the isolated Compose network, and the generated CA expires after two days.

For a local Signal K server, run `npm link` here and `npm link signalk-wakelogger` in the server configuration directory. The plugin loads from `dist/index.js`; rebuild after TypeScript changes. Startup with `{}` and without network access is a required success state.

Tests use Vitest and temporary filesystem directories. Add deterministic delta fixtures for new Signal K paths and crash/recovery cases for changes to outbox semantics. Network integration should use a local MQTT 5 broker with TLS and a fake Wake Logger consumer that acknowledges only after durable test storage.

CI also starts an isolated plaintext Mosquitto container from `test/fixtures/mosquitto.conf` for the fast `npm run test:broker` transport test. The full `npm run test:docker` job adds verified TLS, real Signal K sample input, packaging, abrupt restart and durable recovery coverage. Broker ACL isolation remains part of the private Wake Logger integration and release-environment suites. Never point either public test at a shared or production broker.

`npm run measure:outbox -- <samples>` performs an accelerated synced-write stress run using the production file outbox and prints machine-readable CPU, RSS, disk and throughput results. One sample represents one second; use up to `86400`. It deliberately uses a temporary directory and removes it afterwards. This is useful for comparing candidate builds, but only a real-time run of the packaged plugin on target hardware counts as first-vessel evidence.

Never add a native runtime dependency without proving installation with lifecycle scripts disabled across the Signal K CI matrix. Protocol changes require tests and an update to `telemetry-protocol.md`; incompatible changes require a protocol version change.

The emerging Signal K Database API is deliberately accessed through structural types so released Server API packages can still compile and run the plugin. Test both backend paths. File-backed devices may select the database only after their file queue is empty; database-backed devices must fail safely rather than reuse a file sequence space when the API is unavailable.

Release automation currently accepts beta tags only and publishes them under npm's `beta` dist-tag. A stable release workflow will be added only after its acceptance gate is agreed. The package-name bootstrap and OIDC procedure are in [release.md](release.md). See [the original-plan gap audit](original-plan-gap-audit.md) before claiming first-vessel or public-release readiness.
