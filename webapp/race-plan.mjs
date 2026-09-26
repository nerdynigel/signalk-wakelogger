const NO_PACK_WARNING = 'Recording continues. Onboard race-plan recalculation is unavailable until a Race Pack has previously synchronised. Turn Live tracking on before the race to synchronise the selected Race Plan.'
const STALE_WARNING = 'Onboard race plan may be stale: insufficient or out-of-date vessel observations.'
const NO_CALCULATION_WARNING = 'A Race Pack is available but no onboard calculation has run yet. It will calculate once the race is under way with valid observations.'

function clock(value) {
  if (value === null || value === undefined) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
}

function wind(conditions) {
  if (!conditions || conditions.twsKnots === null || conditions.twdDeg === null) return null
  return `${Number(conditions.twsKnots).toFixed(1)} kn from ${Math.round(conditions.twdDeg)}°`
}

function formatLeg(leg, index) {
  if (!leg) return null
  const outOfRange = leg.conditions?.forecastCoverage === 'out_of_range'
  return {
    index,
    name: leg.to?.name || `Leg ${leg.sequence ?? index + 1}`,
    sequence: leg.sequence ?? null,
    distanceNm: typeof leg.distanceNm === 'number' ? leg.distanceNm : null,
    pointOfSail: leg.pointOfSail ?? null,
    wind: wind(leg.conditions),
    usedObserved: leg.conditions?.source === 'observed',
    summary: outOfRange ? null : leg.plan?.summary ?? null,
    confidence: outOfRange ? null : leg.plan?.confidence ?? null,
    sampleTime: leg.conditions?.sampleTime ?? null,
    outOfRange,
    forecastUnavailable: outOfRange
  }
}

export function racePlanPresentation(racePlan) {
  if (!racePlan || typeof racePlan !== 'object') {
    return {
      uploadMode: null, authority: 'Wake Logger', authorityDetail: 'Waiting for Signal K',
      packAvailable: false, packStatus: 'No Race Pack synced yet', packApplicable: false,
      stale: true, warning: null, lastUpdated: null, currentLeg: null, remainingLegs: [], historyOnly: false
    }
  }
  const onboardAuthority = racePlan.calculationAuthority === 'onboard' || racePlan.uploadMode === 'local_only'
  const authority = onboardAuthority ? 'Onboard' : 'Wake Logger'
  const pack = racePlan.pack || {}
  const snapshot = racePlan.latestSnapshot || null
  const legs = Array.isArray(snapshot?.plan?.legs) ? snapshot.plan.legs : []
  const currentLeg = formatLeg(legs[0], 0)
  const remainingLegs = legs.map((leg, index) => formatLeg(leg, index)).filter(Boolean)
  const packAvailable = pack.available === true
  const packApplicable = pack.applicable !== false
  const revision = pack.revision ?? null
  const packStatus = packAvailable
    ? `Race Pack ready · revision ${revision}${pack.ruleSetVersion ? ` · ${pack.ruleSetVersion}` : ''}`
    : 'No Race Pack synced yet'

  let warning = null
  let stale = false
  if (onboardAuthority) {
    if (!packAvailable) warning = NO_PACK_WARNING
    else if (!packApplicable) warning = 'The Race Pack does not match the selected Wake Logger course. Onboard recommendations are held until the courses match.'
    else if (!snapshot) { warning = NO_CALCULATION_WARNING; stale = true }
  } else if (snapshot) {
    stale = true
  }
  // Per-snapshot warnings (observation fallback, forecast expiry) take
  // precedence because they describe the current plan precisely.
  if (onboardAuthority) {
    if (snapshot?.warning) { warning = snapshot.warning; stale = true }
    else if (snapshot?.forecastCoverage === 'partial' && snapshot?.plan?.warnings?.length) { warning = snapshot.plan.warnings[0]; stale = true }
  }

  return {
    uploadMode: racePlan.uploadMode ?? null,
    authority,
    authorityDetail: onboardAuthority ? 'Calculated on this vessel' : 'Calculated by Wake Logger cloud',
    packAvailable,
    packStatus,
    packApplicable,
    stale,
    warning,
    forecastCoverage: snapshot?.forecastCoverage ?? null,
    observationsReady: racePlan.observationsReady !== false,
    lastUpdated: clock(snapshot?.generatedAt ?? null),
    currentLeg,
    remainingLegs,
    historyOnly: !onboardAuthority && !!snapshot
  }
}
