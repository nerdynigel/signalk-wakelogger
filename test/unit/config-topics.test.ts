import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config/defaults'
import { deviceTopics } from '../../src/transport/topics'

describe('configuration and topics', () => {
  it('uses secure bounded defaults for invalid configuration', () => {
    expect(parseConfig({ pairingApiUrl: 'http://insecure', samplePeriodMs: 1, maxOutboxMb: 99999 })).toMatchObject({
      pairingApiUrl: 'https://wakelogger.com/backend/v1/signalk/pair', samplePeriodMs: 1000, maxOutboxMb: 250
    })
  })
  it('creates only the authenticated device namespace', () => {
    expect(deviceTopics('dev_123').ack).toBe('wakelogger/v1/devices/dev_123/ack')
    expect(() => deviceTopics('../other-device')).toThrow()
  })
})
