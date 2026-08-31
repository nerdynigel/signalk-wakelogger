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

For a local Signal K server, run `npm link` here and `npm link signalk-wakelogger` in the server configuration directory. The plugin loads from `dist/index.js`; rebuild after TypeScript changes. Startup with `{}` and without network access is a required success state.

Tests use Vitest and temporary filesystem directories. Add deterministic delta fixtures for new Signal K paths and crash/recovery cases for changes to outbox semantics. Network integration should use a local MQTT 5 broker with TLS and a fake Wake Logger consumer that acknowledges only after durable test storage.

CI also starts an isolated Mosquitto container from `test/fixtures/mosquitto.conf` and runs `npm run test:broker` with `WAKELOGGER_TEST_MQTT_URL` set to its loopback endpoint. The test broker is intentionally anonymous and plaintext because it is disposable transport-contract coverage; certificate and broker-ACL coverage belongs to the private Wake Logger integration environment. Never point this test at a shared or production broker.

`npm run measure:outbox -- <samples>` performs an accelerated synced-write stress run using the production file outbox and prints machine-readable CPU, RSS, disk and throughput results. One sample represents one second; use up to `86400`. It deliberately uses a temporary directory and removes it afterwards. This is useful for comparing candidate builds, but only a real-time run of the packaged plugin on target hardware counts as first-vessel evidence.

Never add a native runtime dependency without proving installation with lifecycle scripts disabled across the Signal K CI matrix. Protocol changes require tests and an update to `telemetry-protocol.md`; incompatible changes require a protocol version change.

The emerging Signal K Database API is deliberately accessed through structural types so released Server API packages can still compile and run the plugin. Test both backend paths. File-backed devices may select the database only after their file queue is empty; database-backed devices must fail safely rather than reuse a file sequence space when the API is unavailable.

Release automation currently accepts beta tags only and publishes them under npm's `beta` dist-tag. A stable release workflow will be added only after its acceptance gate is agreed. The package-name bootstrap and OIDC procedure are in [release.md](release.md). See [the original-plan gap audit](original-plan-gap-audit.md) before claiming first-vessel or public-release readiness.
