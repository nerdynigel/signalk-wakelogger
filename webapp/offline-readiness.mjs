// Presentation for the coupled offline readiness contract. The plugin derives
// readiness from the selected course, native route and applied Race Pack; this
// module only formats it and produces the prominent pre-switch warning shown
// when the crew chooses local-only with an incomplete setup.
export function offlineReadinessPresentation(readiness) {
  if (!readiness || typeof readiness !== 'object') {
    return { known: false, ready: false, label: 'Offline readiness unknown', missing: [], detail: '' }
  }
  const missing = Array.isArray(readiness.missing) ? readiness.missing.filter((item) => typeof item === 'string' && item.trim()) : []
  return {
    known: true,
    ready: readiness.ready === true,
    label: readiness.ready === true ? 'Offline race ready' : 'Offline race not ready',
    missing,
    detail: typeof readiness.detail === 'string' ? readiness.detail : ''
  }
}

export function localOnlyWarning(readiness) {
  const view = offlineReadinessPresentation(readiness)
  if (view.ready) return null
  const items = view.missing.length ? view.missing.join('; ') : 'offline readiness has not been confirmed'
  return `Offline race not ready: ${items}. Recording continues and local-only can be switched on, but onboard sail planning will not be available until the course and Race Pack match.`
}
