// One presentation for recorder/upload state. Loss semantics are deliberately
// separated: `lifetimeDroppedCount` is the cumulative counter across every
// upload this device has ever made and is never described as belonging to the
// current trip; `cohortDroppedSamples` is the loss observed within the current
// historical-upload cohort and, when attribution is ambiguous, the cohort is
// marked as not progress-known so the recording cannot be called complete.
export function trackingPresentation(status) {
  const valid = status && ['automatic', 'local_only'].includes(status.uploadMode)
  if (!valid) return { enabled: false, available: false, mode: 'Status unavailable', description: 'Reconnect to Signal K to check the recorder.', queue: '', loss: null }
  const enabled = status.uploadMode === 'automatic'
  const revoked = status.connectionState === 'device_revoked'
  const available = status.paired === true && status.available !== false && status.recording !== false && !revoked
  const count = status.queue?.messageCount
  const pending = Number.isSafeInteger(count) && count >= 0 ? count : null
  const lifetimeDropped = Number.isSafeInteger(status.lifetimeDroppedCount) ? status.lifetimeDroppedCount : null
  const cohortDropped = Number.isSafeInteger(status.cohortDroppedSamples) ? status.cohortDroppedSamples : null
  const loss = cohortDropped !== null && cohortDropped > 0
    ? { cohortDropped, lifetimeDropped, progressKnown: status.cohortProgressKnown !== false }
    : null
  let description = revoked ? 'Device access revoked. Pair Wake Logger again in Signal K plugin settings.'
    : status.paired !== true ? 'Pair Wake Logger in Signal K plugin settings first.'
      : !available ? 'Recorder unavailable. Check the Signal K plugin status.'
        : !enabled ? 'Recording locally · cloud uploads paused'
          : status.connectionState === 'online' ? 'Sending live data and saved history'
            : 'Recording locally · uploads resume when connected'
  if (status.persistenceError) description = 'Setting could not be saved. Check the current mode before restarting Signal K.'
  if (loss) description += ` ${loss.cohortDropped} sample${loss.cohortDropped === 1 ? '' : 's'} in this upload were discarded by retention limits; this recording is not complete.`
  return {
    enabled, available,
    mode: revoked ? 'Access revoked' : status.paired !== true ? 'Not paired' : !available ? 'Recorder unavailable' : enabled ? status.connectionState === 'online' ? 'Live + history' : 'Waiting for internet' : 'Record locally',
    description,
    queue: pending === null ? '' : pending ? `${pending.toLocaleString()} samples ${enabled ? 'waiting to upload' : 'saved onboard'}` : 'Upload queue empty',
    loss,
    lifetimeDroppedCount: lifetimeDropped
  }
}

// Recording metadata ACK and empty telemetry queue do not confirm processing.
export function finishedTripPresentation(status) {
  const finished = status?.finishedTrip
  if (!finished) return ''
  const label = status.trackingSessionId ? 'Previous trip' : 'Trip'
  const cloud = finished.cloudStatus
  const connection = status.uploadMode === 'local_only' ? ' · Live tracking off' : status.connectionState !== 'online' ? ' · cloud offline' : ''
  if (cloud?.state === 'ready' && finished.confirmationPending === false) return `${label} confirmed ready by cloud${cloud.environmentPending ? ' · weather enrichment pending' : ''}`
  if (cloud) {
    const reason = cloud.state.replaceAll('_', ' ')
    const missing = cloud.missingSamples > 0 ? ` · ${cloud.missingSamples} samples missing` : ''
    const rejected = cloud.rejectedSamples > 0 ? ` · ${cloud.rejectedSamples} samples rejected` : ''
    return `${label} saved onboard · cloud ${reason}${missing}${rejected} · confirmation pending${connection}`
  }
  return `${label} saved onboard · ${finished.uploadPending ? 'upload pending · ' : ''}awaiting cloud confirmation${connection}`
}

// Finishing is a local save. Queue/cloud/race readiness never gate it.
export function finishTripPresentation(status, { changing = false, finishing = false } = {}) {
  const view = trackingPresentation(status)
  const retry = !status?.trackingSessionId && status?.finishedTrip?.confirmationPending !== false && !!status?.finishedTrip?.manifest?.id
  const recordingId = status?.trackingSessionId ?? (retry ? status.finishedTrip.manifest.id : null)
  let reason = retry ? 'Trip already ended. Check cloud confirmation again.' : 'Save and end the current trip onboard. Cloud uploads can finish later.'
  if (finishing) reason = retry ? 'Checking cloud confirmation…' : 'Saving trip onboard…'
  else if (changing) reason = 'Wait for the live tracking change to finish.'
  else if (!view.available) reason = status?.connectionState === 'device_revoked'
    ? 'Device access revoked. Pair Wake Logger again in Signal K plugin settings.'
    : status?.paired !== true ? 'Pair Wake Logger in Signal K plugin settings first.'
      : 'Recorder unavailable. Check the Signal K plugin status; status checks retry automatically.'
  else if (!recordingId) reason = status?.finishedTrip
    ? status.finishedTrip.cloudStatus?.state === 'ready' && status.finishedTrip.confirmationPending === false
      ? 'Trip already ended. Cloud has confirmed it ready.' : 'Trip already ended and saved onboard.'
    : 'No trip is in progress.'
  if (!status || !['automatic', 'local_only'].includes(status.uploadMode)) reason = 'Recorder status unavailable. Reconnect to Signal K; status checks retry automatically.'
  return { recordingId, retry, disabled: changing || finishing || !view.available || !recordingId,
    label: finishing ? retry ? 'Checking confirmation…' : 'Saving trip…' : retry ? 'Retry confirmation' : 'Finish trip', reason }
}

export function finishTripFailure(error) {
  const prefix = 'Trip could not be finished. '
  if (error.errorCode === 'timeout') return 'Finish request timed out. The trip may have been saved. Check the refreshed recorder status before retrying.'
  if ([401, 403].includes(error.status)) return prefix + 'Sign in to Signal K with permission to control the recorder.'
  if (error.detail === 'recording_not_committed') return prefix + 'Samples have not been saved safely. Check onboard storage, wait for recording to recover, then retry.'
  if (error.detail === 'recording_changed') return prefix + 'The recording changed. Current recorder status is being refreshed; check the trip before retrying.'
  if (error.detail === 'tracking_unavailable') return prefix + 'Recorder unavailable. Reconnect to Signal K and wait for it to become ready.'
  return prefix + 'Check recorder status and try again.'
}

export function confirmTripFinish(status, confirm) {
  const finish = finishTripPresentation(status)
  if (finish.disabled) return false
  if (finish.retry) return true
  return confirm('End this trip? Further movement will start a new trip card. To upload saved history while keeping this trip running, cancel and turn Live tracking on instead.') === true
}
