import { RULE_SET_VERSION } from './pack'

// One deterministic readiness contract for going offline. Readiness is derived
// from the currently selected course, the expected native route and the applied
// Race Pack, and is never stored as a toggle. A course change immediately makes
// every check re-evaluate, so an old immutable pack stays "stored" for history
// or recovery but can never be presented as ready for a new selected course.
//
// Course and Race Pack revisions are separate namespaces; their numeric values
// are never required to match. Applicability is computed from the current
// course identity and course-definition digest, not from an unchecked boolean.
export interface ReadinessCourseState {
  action?: string | null
  revision?: number | null
  courseId?: string | null
  racePlanId?: number | null
  courseDefinitionDigest?: string | null
  /** Number of cached course points, when known. */
  pointCount?: number | null
}

export interface ReadinessAcknowledgement {
  status?: string | null
  revision?: number | null
}

export interface ReadinessNativeState {
  available: boolean
  activeMatchesDesired: boolean
  conflict?: boolean
  reverse?: boolean
}

export interface ReadinessPackState {
  available: boolean
  /** The pack's own monotonic revision; independent of the course revision. */
  revision: number | null
  ruleSetVersion: string | null
  courseId: string | null
  racePlanId: number | null
  courseDefinitionDigest: string | null
  validFrom: string | null
  validUntil: string | null
  /** Declared forecast coverage window, when the pack carries one. */
  coverage?: { from: string | null; until: string | null } | null
  /** Pack validity relative to the current time: valid | not_yet | expired | unknown. */
  currentAt: string
}

export type ForecastCoverage = 'covers_expected_window' | 'valid_now_only' | 'expired' | 'not_yet' | 'unknown'

export interface OfflineReadinessChecks {
  courseApplied: boolean
  nativeActive: boolean
  nativeAvailable: boolean
  racePackReady: boolean
  racePackMatches: boolean
  forecastValidNow: boolean
  forecastCoversRace: boolean
  ruleSetSupported: boolean
}

/**
 * Live-navigation readiness is deliberately separate from offline maps/forecast
 * readiness. A course with cached points is enough to navigate (read-only
 * fallback); a missing Race Pack or unverified chart must never read as "you
 * cannot navigate".
 */
export interface NavigationReadiness {
  ready: boolean
  label: string
  /** Where the displayed course geometry comes from. */
  source: 'native' | 'cached' | 'none'
  missing: string[]
  detail: string
}

export interface OfflineReadiness {
  ready: boolean
  label: 'Offline race ready' | 'Offline race not ready'
  checks: OfflineReadinessChecks
  missing: string[]
  /** Honest caveats that do not by themselves block readiness. */
  uncertainty: string[]
  forecastCoverage: ForecastCoverage
  /** A visible qualification of the forecast coverage (never tooltip-only). */
  coverageQualification: string | null
  /** Whether the pack is stored but does not apply to the selected course. */
  packStoredNotApplicable: boolean
  /** Identity the readiness was evaluated against, so a later course change invalidates it. */
  courseId: string | null
  courseRevision: number | null
  packRevision: number | null
  detail: string
  evaluatedAt: number
  /** Live-navigation readiness, independent of offline preparation. */
  navigation: NavigationReadiness
}

// A forecast that remains valid this far past "now" is treated as covering a
// plausible race window. Shorter validity is reported as valid-now-only rather
// than silently claimed to cover the whole race.
export const EXPECTED_RACE_WINDOW_MS = 12 * 60 * 60 * 1000

function digestMatches(course: string | null | undefined, pack: string | null | undefined): boolean {
  return !!course && !!pack && course.toLowerCase() === pack.toLowerCase()
}

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
  const packMatches = packReady && selected
    && pack!.courseId === course!.courseId
    && (!course!.racePlanId || !pack!.racePlanId || course!.racePlanId === pack!.racePlanId)
    && digestMatches(course!.courseDefinitionDigest, pack!.courseDefinitionDigest)
  const ruleSetSupported = packReady && pack?.ruleSetVersion === RULE_SET_VERSION
  const forecastValidNow = packReady && pack?.currentAt === 'valid'
  const nativeActive = native.available && native.activeMatchesDesired && native.reverse !== true

  const coverageFrom = pack?.coverage?.from ?? pack?.validFrom ?? null
  const coverageUntil = pack?.coverage?.until ?? pack?.validUntil ?? null
  let forecastCoverage: ForecastCoverage
  if (!packReady) forecastCoverage = 'unknown'
  else if (pack?.currentAt === 'expired') forecastCoverage = 'expired'
  else if (pack?.currentAt === 'not_yet') forecastCoverage = 'not_yet'
  else if (!coverageUntil || !Number.isFinite(Date.parse(coverageUntil))) forecastCoverage = 'valid_now_only'
  else if (Date.parse(coverageUntil) >= input.now + EXPECTED_RACE_WINDOW_MS) forecastCoverage = 'covers_expected_window'
  else forecastCoverage = 'valid_now_only'
  const forecastCoversRace = forecastCoverage === 'covers_expected_window'

  const checks: OfflineReadinessChecks = {
    courseApplied,
    nativeActive,
    nativeAvailable: native.available,
    racePackReady: packReady,
    racePackMatches: packMatches,
    forecastValidNow,
    forecastCoversRace,
    ruleSetSupported
  }

  // Live navigation needs only a selected course with cached points. It is
  // never gated on native activation, the Race Pack or offline chart readiness.
  const pointCount = Number.isSafeInteger(course?.pointCount) ? course!.pointCount! : 0
  const navigationPossible = selected && pointCount >= 2
  const navigation: NavigationReadiness = navigationPossible
    ? {
        ready: true,
        label: nativeActive ? 'Live navigation ready' : 'Live navigation ready from the cached course',
        source: nativeActive ? 'native' : 'cached',
        missing: [],
        detail: nativeActive
          ? 'The Wake Logger course is active and live navigation is computing from it.'
          : 'Live navigation is computing from the cached course while native activation is unavailable.'
      }
    : {
        ready: false,
        label: 'No course selected',
        source: 'none',
        missing: ['no Wake Logger course is selected'],
        detail: 'Select a course in Wake Logger to show live navigation.'
      }

  const missing: string[] = []
  if (!selected) missing.push('no Wake Logger course is selected')
  else if (!courseApplied) missing.push('the selected course has not been applied')
  if (!native.available) missing.push('native Signal K course services are unavailable')
  else if (native.reverse === true) missing.push('the active native course is reversed, which the onboard planner does not support')
  else if (!native.activeMatchesDesired) missing.push(native.conflict ? 'another application owns the active route' : 'the expected Wake Logger route is not active')
  if (!packReady) missing.push('no Race Pack has been prepared for this course')
  else {
    if (!packMatches) missing.push('the stored Race Pack does not match the selected course')
    if (!ruleSetSupported) missing.push(`the Race Pack rule set ${pack?.ruleSetVersion ?? 'unknown'} is not supported (expected ${RULE_SET_VERSION})`)
    if (!forecastValidNow) missing.push(pack?.currentAt === 'expired' ? 'the Race Pack forecast has expired' : pack?.currentAt === 'not_yet' ? 'the Race Pack forecast is not yet in effect' : 'the Race Pack has no confirmed forecast validity window')
  }
  const packStoredNotApplicable = packReady && !packMatches

  const uncertainty: string[] = []
  if (packReady && forecastValidNow && forecastCoverage === 'valid_now_only') {
    uncertainty.push(coverageFrom || coverageUntil
      ? 'The Race Pack forecast is valid now but its declared coverage does not confirm the whole race window.'
      : 'The Race Pack has no declared forecast coverage window; only current validity is confirmed.')
  }

  const coverageQualification = !packReady || !forecastValidNow
    ? null
    : forecastCoverage === 'covers_expected_window'
      ? 'Forecast coverage extends at least a nominal race window beyond now; the exact race duration is not known, so this is a heuristic, not proof.'
      : forecastCoverage === 'valid_now_only'
        ? (uncertainty[0] ?? 'Forecast is valid now only; coverage of the whole race window is not confirmed.')
        : null

  const ready = missing.length === 0
  return {
    ready,
    label: ready ? 'Offline race ready' : 'Offline race not ready',
    checks,
    missing,
    uncertainty,
    forecastCoverage,
    coverageQualification,
    packStoredNotApplicable,
    courseId: selected ? course?.courseId ?? null : null,
    courseRevision: selected ? course?.revision ?? null : null,
    packRevision: packReady ? pack?.revision ?? null : null,
    detail: ready
      ? `Course applied, native route active, matching Race Pack prepared with supported rules and a forecast valid now.${coverageQualification ? ` ${coverageQualification}` : ''}`
      : `Missing: ${missing.join('; ')}.`,
    evaluatedAt: input.now,
    navigation
  }
}
