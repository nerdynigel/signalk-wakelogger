export const configSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
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
    }
  }
} as const
