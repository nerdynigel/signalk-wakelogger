import { RULE_SET_VERSION } from './pack'

// One deterministic readiness contract for going offline. Readiness is derived
// from the currently selected course, the expected native route and the applied
// Race Pack. It is never stored as a toggle: a course change immediately makes
// every check re-evaluate, so an old immutable pack can be retained for history
// but can never be presented as ready for a new selected course.
export interface ReadinessCourseState {
  action?: string | null
  revision?: number | null
  courseId?: string | null
  racePlanId?: number | null
  courseDefinitionDigest?: string | null
}

export interface ReadinessAcknowledgement {
  status?: string | null
  revision?: number | null
}

export interface ReadinessNativeState {
  available: boolean
  activeMatchesDesired: boolean
  conflict?: boolean
}

export interface ReadinessPackState {
  available: boolean
  applicable: boolean
  revision: number | null
  ruleSetVersion: string | null
  courseId: string | null
  racePlanId: number | null
  courseDefinitionDigest: string | null
  validUntil: string | null
  /** Pack validity relative to the current time: valid | not_yet | expired | unknown. */
  currentAt: string
}

export interface OfflineReadinessChecks {
  courseApplied: boolean
  nativeActive: boolean
  nativeAvailable: boolean
  racePackReady: boolean
  racePackMatches: boolean
  forecastCoversRace: boolean
  ruleSetSupported: boolean
}

export interface OfflineReadiness {
  ready: boolean
  label: 'Offline race ready' | 'Offline race not ready'
  checks: OfflineReadinessChecks
  missing: string[]
  detail: string
  evaluatedAt: number
}

// `forecastCoversRace` is proven by a Race Pack whose declared validity window
// is current (not expired, not not-yet-active) and which carries forecast
// samples. A pack with no validity window cannot prove coverage, so it is not
// treated as ready.
export function offlineReadiness(input: {
  course: ReadinessCourseState | null
  acknowledgement: ReadinessAcknowledgement | null
  native: ReadinessNativeState
  pack: ReadinessPackState | null
  now: number
}): OfflineReadiness {
  const { course, acknowledgement, native, pack } = input
  const selected = !!course && course.action !== 'clear'
  const courseApplied = selected
    && acknowledgement?.status === 'applied'
    && Number.isSafeInteger(acknowledgement.revision)
    && acknowledgement.revision === course?.revision
  const packReady = !!pack?.available
  const packMatches = packReady && !!pack?.applicable
  const ruleSetSupported = packReady && pack?.ruleSetVersion === RULE_SET_VERSION
  const forecastCoversRace = packReady && pack?.currentAt === 'valid'
  const nativeActive = native.activeMatchesDesired === true

  const checks: OfflineReadinessChecks = {
    courseApplied,
    nativeActive,
    nativeAvailable: native.available,
    racePackReady: packReady,
    racePackMatches: packMatches,
    forecastCoversRace,
    ruleSetSupported
  }

  const missing: string[] = []
  if (!selected) missing.push('no Wake Logger course is selected')
  else if (!courseApplied) missing.push('the selected course has not been applied')
  if (!native.available) missing.push('native Signal K course services are unavailable')
  else if (!nativeActive) missing.push(native.conflict ? 'another application owns the active route' : 'the expected Wake Logger route is not active')
  if (!packReady) missing.push('no Race Pack has been prepared for this course')
  else {
    if (!packMatches) missing.push('the stored Race Pack does not match the selected course')
    if (!ruleSetSupported) missing.push(`the Race Pack rule set ${pack?.ruleSetVersion ?? 'unknown'} is not supported (expected ${RULE_SET_VERSION})`)
    if (!forecastCoversRace) missing.push(pack?.currentAt === 'expired' ? 'the Race Pack forecast has expired' : 'the Race Pack forecast validity does not cover the race')
  }

  const ready = missing.length === 0
  return {
    ready,
    label: ready ? 'Offline race ready' : 'Offline race not ready',
    checks,
    missing,
    detail: ready
      ? 'Course applied, native route active, matching Race Pack prepared with supported rules and current forecast.'
      : `Missing: ${missing.join('; ')}.`,
    evaluatedAt: input.now
  }
}
