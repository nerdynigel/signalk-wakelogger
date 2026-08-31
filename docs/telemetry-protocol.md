# Telemetry protocol v1

All topics are beneath `wakelogger/v1/devices/<deviceId>`:

| Suffix | Direction | Retained | Purpose |
|---|---|---:|---|
| `telemetry` | device → cloud | no | Ordered sample batches |
| `state` | device → cloud | yes | Latest sample for reconnect priority |
| `status` | device → cloud | yes | Online/offline state, Last Will and bounded plugin/outbox diagnostics |
| `events` | device → cloud | no | Advisory trip evidence |
| `ack` | cloud → device | yes | Highest contiguously committed sequence, restored on reconnect |
| `profile` | cloud → device | yes | Approved, versioned sampling and transport profile |
| `profile-ack` | device → cloud | yes | Applied/rejected profile revision result |

Telemetry is JSON and bounded to 64 KiB. A batch has `v`, `deviceId`, optional `droppedThrough`, and up to 60 `samples`. `droppedThrough` explicitly closes a sequence gap caused by local retention or corrupt-tail recovery so the cloud can advance its contiguous cursor while recording data loss. Each sample contains:

```json
{
  "v": 1,
  "deviceId": "dev_xxx",
  "sequence": 184291,
  "capturedAt": 1788143912000,
  "receivedAt": 1788143912050,
  "trackingSessionId": "optional-uuid",
  "values": {
    "lat": -27.41238,
    "lon": 153.18291,
    "sog_kn": 6.42,
    "cog_deg": 241.3,
    "heading_deg": 238.8,
    "heading_reference": "true",
    "depth_m": 12.4,
    "aws_kn": 15.2,
    "awa_deg": 315
  },
  "quality": {
    "timestamp": "source"
  }
}
```

Times are UTC Unix milliseconds. Latitude/longitude are decimal degrees; speeds are knots; angles are degrees in `[0,360)`; depth is metres. Apparent wind angle follows Signal K's starboard-positive convention after normalization. Heading uses true heading when present and explicitly marks magnetic fallback.

An acknowledgement is `{"v":1,"deviceId":"dev_xxx","ackSequence":184291,"acknowledgedAt":1788143912200}`. It means every sequence through that value was durably accepted or intentionally rejected under a server policy. Older backlog may arrive after retained current state; it must still be inserted by capture time. Current state changes only when `capturedAt` is newer.

Trip evidence is also embedded in its source sample for durable recovery. The event topic is a convenience notification and consumers must deduplicate by `deviceId + sequence`.

The retained status document includes `v`, `state` and `at`. A running plugin also reports `pluginVersion`, `queueMessageCount`, `queueDiskBytes`, optional `queueOldestCapturedAt`, `queueDroppedCount`, `acknowledgedSequence`, `currentSequence` and optional `trackingState`. These fields contain operational counters only—never credentials or telemetry values—and allow Wake Logger administrators to identify vessel-side backlog and loss.

Status also reports `storageBackend`, `networkMode`, `modeReason`, `profileId`, `profileRevision`, `lastAcknowledgedAt`, `acknowledgementLatencyMs`, `reconnectCount` and `publishedBytes`. Profiles contain exactly the supported fields (`position`, `sog`, `cog`, `heading`, `depth`, `apparentWind`) with enabled flags and millisecond periods for `NORMAL`, `CONSTRAINED` and `OFFLINE`, plus bounded batching and replay byte rates. Position cannot be disabled. A profile acknowledgement reports `profileId`, `revision`, `status`, `at`, and a bounded error code when rejected.
