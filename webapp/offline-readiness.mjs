// Presentation for the coupled offline readiness contract. The plugin derives
// two independent states: live-navigation readiness (a selected course with
// cached points) and offline maps/forecast readiness (native route + Race Pack
// + chart preparation). This module only formats them. Offline readiness must
// never read as "you cannot navigate".
const NAV_SOURCES = ['native', 'cached', 'none']

function navigationView(readiness) {
  const navigation = readiness && typeof readiness === 'object' ? readiness.navigation : null
  if (!navigation || typeof navigation !== 'object') {
    return { known: false, ready: false, label: 'Navigation status unknown', source: 'none', missing: [], detail: '' }
  }
  const missing = Array.isArray(navigation.missing) ? navigation.missing.filter((item) => typeof item === 'string' && item.trim()) : []
  return {
    known: true,
    ready: navigation.ready === true,
    label: typeof navigation.label === 'string' && navigation.label.trim() ? navigation.label : navigation.ready === true ? 'Live navigation ready' : 'No course selected',
    source: NAV_SOURCES.includes(navigation.source) ? navigation.source : 'none',
    missing,
    detail: typeof navigation.detail === 'string' ? navigation.detail : ''
  }
}

export function offlineReadinessPresentation(readiness) {
  if (!readiness || typeof readiness !== 'object') {
    return {
      known: false, ready: false, label: 'Offline readiness unknown', missing: [], detail: '',
      offline: { ready: false, label: 'Offline readiness unknown', missing: [] },
      navigation: navigationView(null)
    }
  }
  const missing = Array.isArray(readiness.missing) ? readiness.missing.filter((item) => typeof item === 'string' && item.trim()) : []
  const offlineLabel = readiness.ready === true ? 'Offline race ready' : 'Offline race not ready'
  return {
    known: true,
    ready: readiness.ready === true,
    label: offlineLabel,
    missing,
    detail: typeof readiness.detail === 'string' ? readiness.detail : '',
    offline: { ready: readiness.ready === true, label: offlineLabel, missing },
    navigation: navigationView(readiness)
  }
}

// An informational banner for the Race tab. It always states live-navigation
// status first and lists exactly what offline preparation is missing. It is
// never a data gate: a missing Race Pack or unverified chart is reported but
// live navigation remains available.
export function raceNavigationBanner(readiness) {
  const view = offlineReadinessPresentation(readiness)
  if (!view.navigation.known && !view.known) return null
  if (view.navigation.ready && view.offline.ready) return null
  if (view.navigation.ready) {
    const source = view.navigation.source === 'native' ? 'the active course' : 'the cached course'
    const offline = view.offline.missing.length ? view.offline.missing.join('; ') : 'offline preparation has not been confirmed'
    return `Live navigation active from ${source}. Offline race not ready: ${offline}.`
  }
  return view.navigation.detail || 'No Wake Logger course is selected for live navigation.'
}

export function localOnlyWarning(readiness) {
  const view = offlineReadinessPresentation(readiness)
  if (view.ready) return null
  const items = view.missing.length ? view.missing.join('; ') : 'offline readiness has not been confirmed'
  const navigation = view.navigation.ready
    ? 'Live navigation from the selected course continues.'
    : 'Select a course to enable live navigation.'
  return `Offline race not ready: ${items}. Recording continues and local-only can be switched on. ${navigation} Onboard sail planning will not be available until the course and Race Pack match.`
}
