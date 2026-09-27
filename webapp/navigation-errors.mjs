// Human-readable, credentialed-safe descriptions for failed onboard navigation
// requests. The crew sees which action failed, the target mark where known, and
// the bounded Signal K reason; the raw diagnostic detail stays out of the UI.
const ACTION_LABELS = {
  'activate-course': { verb: 'activate the Wake Logger course', target: 'Signal K rejected the course activation' },
  'set-point': { verb: 'set the active course point', target: 'Signal K rejected the active route update' },
  'next-point': { verb: 'advance to the next course point', target: 'Signal K rejected the active route update' },
  'resolve-progression': { verb: 'record the mark rounding', target: 'Signal K rejected the request' },
  'set-progression-mode': { verb: 'change the mark detection mode', target: 'Signal K rejected the request' },
  'read-active-course': { verb: 'read the active course', target: 'Signal K rejected the request' }
}

function markName(context) {
  if (!context) return null
  if (typeof context.markName === 'string' && context.markName.trim()) return context.markName.trim()
  if (Number.isInteger(context.markNumber) && context.markNumber > 0) return `Mark ${context.markNumber}`
  return null
}

export function describeNavigationFailure(error, context = {}) {
  if (!error) return 'The navigation update failed.'
  const status = error.status
  const reason = error.detail || error.errorCode || null
  const suffix = reason ? `: ${String(reason).replace(/[.\s]+$/, '')}.` : '.'
  if (status === 401 || status === 403) {
    return 'Sign in to Signal K with an account that can change the course, then try again.'
  }
  const operation = error.operation || context.action
  const label = ACTION_LABELS[operation]
  const target = markName(context)
  if (operation === 'set-point' || operation === 'next-point') {
    const pronoun = target ? ` to ${target}` : ''
    return `Could not ${label ? label.verb : 'change the active point'}${pronoun} — ${label?.target ?? 'Signal K rejected the request'}${suffix}`
  }
  if (label) return `Could not ${label.verb} — ${label.target}${suffix}`
  if (target) return `Could not update ${target} — Signal K rejected the request${suffix}`
  return error.message || 'The navigation update failed.'
}
