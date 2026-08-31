export interface DeviceTopics {
  telemetry: string
  state: string
  status: string
  events: string
  ack: string
  profile: string
  profileAck: string
}

export function deviceTopics(deviceId: string): DeviceTopics {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error('Invalid device identifier')
  const base = `wakelogger/v1/devices/${deviceId}`
  return {
    telemetry: `${base}/telemetry`, state: `${base}/state`, status: `${base}/status`,
    events: `${base}/events`, ack: `${base}/ack`, profile: `${base}/profile`, profileAck: `${base}/profile-ack`
  }
}
