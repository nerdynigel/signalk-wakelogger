export const configSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    guidance: { type: 'object', title: 'Sailing guidance', additionalProperties: false, properties: {
      enabled: { type: 'boolean', title: 'Enabled', default: true },
      polar: { type: 'object', title: 'Validated vessel polars', additionalProperties: false, required: ['id', 'validated', 'points'], properties: {
        id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }, validated: { type: 'boolean', enum: [true] },
        points: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['twsKn', 'upwindTwaDeg', 'upwindSpeedKn', 'downwindTwaDeg', 'downwindSpeedKn'], properties: {
          twsKn: { type: 'number', minimum: 0, maximum: 150 }, upwindTwaDeg: { type: 'number', minimum: 20, maximum: 75 }, upwindSpeedKn: { type: 'number', minimum: 0.5, maximum: 80 },
          downwindTwaDeg: { type: 'number', minimum: 100, maximum: 175 }, downwindSpeedKn: { type: 'number', minimum: 0.5, maximum: 80 }
        } } }
      } },
      calibration: { type: 'object', title: 'Validated vessel calibration', additionalProperties: false,
        required: ['id', 'validated', 'heelCoefficient'], properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }, validated: { type: 'boolean', enum: [true] },
          heelCoefficient: { type: 'number', minimum: -100, maximum: 100 },
          portHeelCoefficient: { type: 'number', minimum: -100, maximum: 100 },
          starboardHeelCoefficient: { type: 'number', minimum: -100, maximum: 100 },
          rudderCoefficient: { type: 'number', minimum: -2, maximum: 2 },
          minSpeedKn: { type: 'number', minimum: 0.5, maximum: 10 },
          maxLeewayDeg: { type: 'number', minimum: 1, maximum: 25 }
        } }
    } },
    uploadMode: {
      type: 'string',
      title: 'Upload mode',
      enum: ['automatic', 'local_only'],
      enumNames: ['Automatic upload', 'Record locally'],
      default: 'local_only',
      description: 'Legacy upload setting. Live tracking is controlled only by the confirmed switch in the onboard Wake Logger app; saving this setting cannot enable uploads.'
    },
    pairingCode: {
      type: 'string',
      title: 'Wake Logger pairing code',
      description: 'Single-use code generated in Wake Logger. It is not retained as an MQTT credential.'
    },
    pairingApiUrl: {
      type: 'string',
      title: 'Pairing API URL',
      default: 'https://wakelogger.com/backend/v1/signalk/pair',
      pattern: '^https://'
    },
    samplePeriodMs: {
      type: 'integer',
      title: 'Sample interval (milliseconds)',
      minimum: 250,
      maximum: 60000,
      default: 1000
    },
    maxOutboxMb: {
      type: 'integer',
      title: 'Maximum offline queue size (MB)',
      minimum: 10,
      maximum: 4096,
      default: 250
    },
    maxOutboxDays: {
      type: 'integer',
      title: 'Maximum offline queue age (days)',
      minimum: 1,
      maximum: 30,
      default: 7
    },
    debugTelemetry: {
      type: 'boolean',
      title: 'Enable telemetry debug logging',
      default: false
    },
    raceProgressionMode: {
      type: 'string',
      title: 'Mark detection mode',
      enum: ['auto', 'suggest', 'off'],
      enumNames: ['Automatic', 'Suggest', 'Off'],
      default: 'auto',
      description: 'Automatic advances the active course point when the onboard app detects a rounding, start or finish; it also records evidence for Wake Logger. Suggest asks the crew first. Off records evidence only.'
    }
  }
} as const
