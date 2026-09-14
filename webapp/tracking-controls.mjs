export function trackingPresentation(status) {
  const valid = status && ['automatic', 'local_only'].includes(status.uploadMode)
  if (!valid) return { enabled: false, available: false, mode: 'Status unavailable', description: 'Reconnect to Signal K to check the recorder.', queue: '' }
  const enabled = status.uploadMode === 'automatic'
  const revoked = status.connectionState === 'device_revoked'
  const available = status.paired === true && status.available !== false && status.recording !== false && !revoked
  const count = status.queue?.messageCount
  const pending = Number.isSafeInteger(count) && count >= 0 ? count : null
  let description = revoked ? 'Device access revoked. Pair Wake Logger again in Signal K plugin settings.'
    : status.paired !== true ? 'Pair Wake Logger in Signal K plugin settings first.'
      : !available ? 'Recorder unavailable. Check the Signal K plugin status.'
      : !enabled ? 'Recording locally · cloud uploads paused'
        : status.connectionState === 'online' ? 'Sending live data and saved history'
          : 'Recording locally · uploads resume when connected'
  if (status.persistenceError) description = 'Setting could not be saved. Check the current mode before restarting Signal K.'
  return {
    enabled, available,
    mode: revoked ? 'Access revoked' : status.paired !== true ? 'Not paired' : !available ? 'Recorder unavailable' : enabled ? status.connectionState === 'online' ? 'Live + history' : 'Waiting for internet' : 'Record locally',
    description,
    queue: pending === null ? '' : pending ? `${pending.toLocaleString()} samples ${enabled ? 'waiting to upload' : 'saved onboard'}` : 'Upload queue empty',
  }
}
