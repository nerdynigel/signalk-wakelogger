const SAIL_STATUS_AVAILABLE = 'Available'
const SAIL_STATUS_TRAINING_ONLY = 'Training only'
const SAIL_STATUS_HEAVY_WEATHER_ONLY = 'Heavy weather only'
const SAIL_EXCLUDED_STATUSES = new Set(['In repair', 'Not carried', 'Retired'])
const UNSAFE_AWS_MARGIN_KNOTS = 5
const GUST_MARGIN_KNOTS = 3
const RANGE_TOLERANCE_RATIO = 0.1

const RACE_JIB_TYPES = new Set(['no. 1 jib', 'no. 2 jib', 'no. 3 jib', 'no. 4 jib'])

const MAINSAIL_CONFIGURATION_LABELS: Record<string, string> = {
  full_main: 'Full main',
  reef_1: 'Reef 1 main',
  reef_2: 'Reef 2 main',
  reef_3: 'Reef 3 main',
  trysail_consideration: 'Trysail consideration'
}

const REEF_STATUS_RANK: Record<string, number> = { none: 0, consider_reef_1: 1, consider_reef_2: 2, consider_reef_3: 3 }

export interface SailInventoryItem {
  id: number
  sail_name?: string | null
  sail_type?: string | null
  availability_status?: string | null
  is_available?: boolean | null
  archived_at?: string | null
  max_aws_knots?: number | null
  min_awa_deg?: number | null
  max_awa_deg?: number | null
  min_twa_deg?: number | null
  max_twa_deg?: number | null
  min_tws_knots?: number | null
  max_tws_knots?: number | null
  crew_required?: number | null
  reef_1_tws_knots?: number | null
  reef_2_tws_knots?: number | null
  reef_3_tws_knots?: number | null
  reef_1_notes?: string | null
  reef_2_notes?: string | null
  reef_3_notes?: string | null
}

export interface SailCandidate {
  sail_id: number
  sail_name: string
  sail_type: string
  score: number
  performance_score: number
  crew_required: number | null
  crew_compatible: boolean
  sail_category: string
  availability_status: string
  reasons: string[]
  warnings: string[]
  race_average_score?: number
  race_weighted_leg_count?: number
  race_leg_sequences?: number[]
  race_selection_reason?: string
}

export interface SailRecommendation {
  sail_id: number
  sail_name: string
  sail_type: string
  crew_required: number | null
  crew_compatible: boolean
  confidence: string
  reasons: string[]
  warnings: string[]
}

export interface CandidateParams {
  point_of_sail: string
  twa_deg: number
  forecast_tws_knots: number
  forecast_gust_knots: number
  awa_deg: number
  aws_knots: number
  apparent_gust_knots: number
  available_crew_count: number | null
}

function pyRound(value: number, digits: number): number {
  const factor = 10 ** digits
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const fraction = scaled - floor
  const rounded = fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled)
  return rounded / factor
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

export function sailCategory(sailType: string | null | undefined): string {
  const normalized = String(sailType ?? '').trim().toLowerCase()
  if (normalized.includes('trysail')) return 'trysail'
  if (normalized.includes('main')) return 'mainsail'
  if (normalized.includes('mizzen staysail')) return 'mizzen_staysail'
  if (normalized.includes('mizzen')) return 'mizzen'
  if (['storm jib', 'heavy-weather jib', 'heavy weather jib', 'staysail', 'genoa', 'jib'].some((token) => normalized.includes(token))) return 'headsail'
  if (['code', 'reacher', 'drifter'].some((token) => normalized.includes(token))) return 'reaching'
  if (['spinnaker', 'gennaker', 'asymmetric', 'symmetric', 'a1', 'a2', 'a3', 'a4', 'a5'].some((token) => normalized.includes(token))) return 'downwind'
  return 'other'
}

export function isRaceJib(sailType: string | null | undefined): boolean {
  return RACE_JIB_TYPES.has(String(sailType ?? '').trim().toLowerCase())
}

export function rangeScore(options: { value: number; minimum: number | null; maximum: number | null; label: string; reasons: string[]; warnings: string[]; primary: boolean }): number {
  const { value, minimum, maximum, label, reasons, warnings, primary } = options
  if (minimum === null && maximum === null) {
    warnings.push(`${label} range is not set.`)
    return primary ? -4 : -2
  }
  if (minimum !== null && value < minimum) {
    const delta = minimum - value
    const tolerance = Math.max(Math.abs(minimum) * RANGE_TOLERANCE_RATIO, 0.5)
    if (delta <= tolerance) {
      reasons.push(`${label} is within 10% planning tolerance.`)
      warnings.push(`${label} is ${formatNumber(pyRound(delta, 1))} below the recorded range, inside planning tolerance.`)
      return primary ? 8 : 3
    }
    warnings.push(`${label} is ${formatNumber(pyRound(delta, 1))} below the sail range.`)
    return -20 - delta * (primary ? 0.8 : 0.4)
  }
  if (maximum !== null && value > maximum) {
    const delta = value - maximum
    const tolerance = Math.max(Math.abs(maximum) * RANGE_TOLERANCE_RATIO, 0.5)
    if (delta <= tolerance) {
      reasons.push(`${label} is within 10% planning tolerance.`)
      warnings.push(`${label} is ${formatNumber(pyRound(delta, 1))} above the recorded range, inside planning tolerance.`)
      return primary ? 8 : 3
    }
    warnings.push(`${label} is ${formatNumber(pyRound(delta, 1))} above the sail range.`)
    return -20 - delta * (primary ? 0.8 : 0.4)
  }
  reasons.push(`${label} is within range.`)
  return primary ? 18 : 8
}

export function sailTypeScore(sailType: string, pointOfSail: string, forecastTwsKnots: number, reasons: string[], warnings: string[]): number {
  const normalized = sailType.toLowerCase()
  const isMain = normalized.includes('main')
  const isJib = ['jib', 'genoa', 'staysail'].some((token) => normalized.includes(token))
  const isReaching = ['code', 'reacher', 'drifter', 'gennaker'].some((token) => normalized.includes(token))
  const isSpinnaker = normalized.includes('spinnaker') || normalized.includes('gennaker')
  const isHeavy = ['storm', 'heavy', 'trysail'].some((token) => normalized.includes(token))
  let score = 0

  if (isMain) {
    reasons.push('Mainsail type is useful across most points of sail.')
    score += 10
  }
  if (pointOfSail === 'close-hauled' || pointOfSail === 'close reach') {
    if (isJib || isReaching) {
      reasons.push('Sail type suits upwind and reaching work.')
      score += 16
    }
    if (isSpinnaker) {
      warnings.push('Spinnaker type is less suitable this close to the wind.')
      score -= 24
    }
  } else if (pointOfSail === 'beam reach' || pointOfSail === 'broad reach') {
    if (isReaching || isSpinnaker) {
      reasons.push('Sail type suits reaching angles.')
      score += 18
    } else if (isJib) {
      score += 8
    }
  } else if (pointOfSail === 'running') {
    if (isSpinnaker) {
      reasons.push('Spinnaker type suits running angles.')
      score += 20
    } else if (isReaching) {
      score += 10
    } else if (isJib) {
      warnings.push('Headsail may be conservative for running angles.')
      score += 2
    }
  } else {
    warnings.push('Generic sail type assumptions are weak in the no-sail zone.')
    score -= 10
  }

  if (isHeavy && forecastTwsKnots >= 20) {
    reasons.push('Heavy-weather sail type suits stronger wind.')
    score += 18
  } else if (isHeavy) {
    warnings.push('Heavy-weather sail type may be conservative for this wind speed.')
    score -= 8
  }

  if (score === 0) warnings.push('Recommendation uses generic sail type assumptions.')
  return score
}

export function mainsailConfiguration(reefing: { status?: string | null }, options: { trysailAvailable: boolean }): string {
  const status = String(reefing.status || 'none')
  if (status === 'consider_reef_3' && options.trysailAvailable) return 'trysail_consideration'
  if (status === 'consider_reef_3') return 'reef_3'
  if (status === 'consider_reef_2') return 'reef_2'
  if (status === 'consider_reef_1') return 'reef_1'
  return 'full_main'
}

export function confidenceForScore(score: number, warnings: string[]): string {
  if (score >= 92 && warnings.length <= 1) return 'high'
  if (score >= 68) return 'medium'
  return 'low'
}

export function reefingRecommendation(sails: SailInventoryItem[], options: { forecastTwsKnots: number; forecastGustKnots: number }): { status: string; notes: string[]; warnings: string[] } {
  const activeSails = sails.filter((sail) =>
    sail.archived_at == null &&
    Boolean(sail.is_available) &&
    !SAIL_EXCLUDED_STATUSES.has(String(sail.availability_status || SAIL_STATUS_AVAILABLE))
  )
  const mainsails = activeSails.filter((sail) => ['mainsail', 'reefed mainsail'].includes(String(sail.sail_type || '').toLowerCase()))
  const trysailAvailable = activeSails.some((sail) => String(sail.sail_type || '').toLowerCase() === 'trysail')
  if (!mainsails.length) return { status: 'none', notes: [], warnings: ['No active mainsail reef thresholds are recorded.'] }

  let bestStatus = 'none'
  const notes: string[] = []
  const warnings: string[] = []
  for (const sail of mainsails) {
    const thresholds: Array<[string, number | null, string | null | undefined]> = [
      ['consider_reef_1', num(sail.reef_1_tws_knots), sail.reef_1_notes],
      ['consider_reef_2', num(sail.reef_2_tws_knots), sail.reef_2_notes],
      ['consider_reef_3', num(sail.reef_3_tws_knots), sail.reef_3_notes]
    ]
    for (const [status, threshold, note] of thresholds) {
      if (threshold === null) continue
      if (options.forecastTwsKnots >= threshold || options.forecastGustKnots >= threshold + GUST_MARGIN_KNOTS) {
        if ((REEF_STATUS_RANK[status] ?? 0) > (REEF_STATUS_RANK[bestStatus] ?? 0)) bestStatus = status
        if (note) notes.push(String(note))
      }
    }
  }
  if (bestStatus === 'consider_reef_3' && trysailAvailable) {
    warnings.push('Reef 3 threshold is exceeded; consider whether the trysail is appropriate.')
  }
  return { status: bestStatus, notes: [...new Set(notes)], warnings }
}

export function candidateForSail(sail: SailInventoryItem, params: CandidateParams): SailCandidate | null {
  const status = String(sail.availability_status || SAIL_STATUS_AVAILABLE)
  if (sail.archived_at != null || !sail.is_available || SAIL_EXCLUDED_STATUSES.has(status)) return null

  const maxAws = num(sail.max_aws_knots)
  if (maxAws !== null && params.aws_knots > maxAws * (1 + RANGE_TOLERANCE_RATIO) + UNSAFE_AWS_MARGIN_KNOTS) return null

  const reasons: string[] = []
  const warnings: string[] = []
  let score = 50
  score += rangeScore({ value: params.awa_deg, minimum: num(sail.min_awa_deg), maximum: num(sail.max_awa_deg), label: 'AWA', reasons, warnings, primary: true })
  score += rangeScore({ value: params.aws_knots, minimum: null, maximum: maxAws, label: 'AWS', reasons, warnings, primary: true })
  score += rangeScore({ value: params.twa_deg, minimum: num(sail.min_twa_deg), maximum: num(sail.max_twa_deg), label: 'TWA', reasons, warnings, primary: false })
  score += rangeScore({ value: params.forecast_tws_knots, minimum: num(sail.min_tws_knots), maximum: num(sail.max_tws_knots), label: 'TWS', reasons, warnings, primary: false })
  score += sailTypeScore(String(sail.sail_type || ''), params.point_of_sail, params.forecast_tws_knots, reasons, warnings)
  const performanceScore = score

  if (maxAws !== null) {
    if (params.aws_knots > maxAws) {
      warnings.push('Apparent wind speed exceeds sail limit.')
      score -= 25
    } else if (params.aws_knots >= maxAws - GUST_MARGIN_KNOTS) {
      warnings.push('Apparent wind speed is close to sail limit.')
      score -= 10
    }
    if (params.apparent_gust_knots > maxAws) warnings.push('Estimated apparent gust exceeds sail limit.')
    else if (params.apparent_gust_knots >= maxAws - GUST_MARGIN_KNOTS) warnings.push('Estimated apparent gust is close to sail limit.')
  }
  const maxTws = num(sail.max_tws_knots)
  if (maxTws !== null && params.forecast_gust_knots > maxTws * (1 + RANGE_TOLERANCE_RATIO)) {
    warnings.push("Forecast true gust exceeds sail's configured true wind range.")
  }

  const crewRequired = int(sail.crew_required)
  const crewCompatible = !(params.available_crew_count !== null && crewRequired !== null && crewRequired > params.available_crew_count)
  if (!crewCompatible) {
    warnings.push(`${sail.sail_name} requires ${crewRequired} crew; only ${params.available_crew_count} crew available.`)
    score -= 35 + ((crewRequired! - params.available_crew_count!) * 8)
  } else if (crewRequired !== null) {
    reasons.push(`Crew requirement is ${crewRequired}.`)
  }

  if (status === SAIL_STATUS_TRAINING_ONLY) {
    warnings.push('Sail is marked training only.')
    score -= 18
  } else if (status === SAIL_STATUS_HEAVY_WEATHER_ONLY) {
    warnings.push('Sail is marked heavy weather only.')
    score += params.forecast_tws_knots >= 20 ? 15 : -12
  }

  return {
    sail_id: int(sail.id) ?? 0,
    sail_name: String(sail.sail_name || 'Sail'),
    sail_type: String(sail.sail_type || 'Custom sail'),
    score: pyRound(score, 1),
    performance_score: pyRound(performanceScore, 1),
    crew_required: crewRequired,
    crew_compatible: crewCompatible,
    sail_category: sailCategory(String(sail.sail_type || '')),
    availability_status: status,
    reasons: reasons.slice(0, 6),
    warnings: warnings.slice(0, 8)
  }
}

export function recommendSails(sails: SailInventoryItem[], params: CandidateParams): [SailCandidate[], SailRecommendation | null] {
  const candidates: SailCandidate[] = []
  for (const sail of sails) {
    const candidate = candidateForSail(sail, params)
    if (candidate) candidates.push(candidate)
  }
  candidates.sort((left, right) => right.score - left.score)
  if (!candidates.length) return [[], null]

  let performanceBest = candidates[0]!
  for (const candidate of candidates) {
    if ((candidate.performance_score ?? candidate.score) > (performanceBest.performance_score ?? performanceBest.score)) performanceBest = candidate
  }
  let recommended = candidates[0]!
  if (params.available_crew_count !== null) {
    const crewCompatible = candidates.filter((candidate) => candidate.crew_compatible)
    if (crewCompatible.length) recommended = crewCompatible[0]!
  }
  const nonMainCompatible = candidates.filter((candidate) => candidate.crew_compatible && !['mainsail', 'trysail'].includes(candidate.sail_category))
  if (['mainsail', 'trysail'].includes(recommended.sail_category) && nonMainCompatible.length) recommended = nonMainCompatible[0]!
  if (performanceBest !== recommended && !performanceBest.crew_compatible) {
    recommended.warnings.push(`${performanceBest.sail_name} may be faster but requires ${performanceBest.crew_required} crew; only ${params.available_crew_count} available.`)
  }

  const compatibleCandidates = candidates.filter((candidate) => candidate.crew_compatible)
  const incompatibleCandidates = candidates.filter((candidate) => !candidate.crew_compatible)
  const orderedCandidates = compatibleCandidates.concat(incompatibleCandidates.slice(0, 2))
  const confidence = confidenceForScore(recommended.score, [...recommended.warnings])
  return [orderedCandidates.slice(0, 5), {
    sail_id: recommended.sail_id,
    sail_name: recommended.sail_name,
    sail_type: recommended.sail_type,
    crew_required: recommended.crew_required,
    crew_compatible: recommended.crew_compatible,
    confidence,
    reasons: [...recommended.reasons],
    warnings: [...recommended.warnings]
  }]
}

function planItemFrom(
  fields: { sail_id?: number | null; sail_name?: string | null; sail_type?: string | null; sail_category?: string | null; crew_required?: number | null } | null,
  options: { configuration?: string | null; warning?: string | null } = {}
): Record<string, unknown> | null {
  if (!fields) return null
  const item: Record<string, unknown> = {
    sail_id: fields.sail_id ?? null,
    sail_name: fields.sail_name ?? null,
    sail_type: fields.sail_type ?? null,
    sail_category: fields.sail_category ?? null,
    crew_required: fields.crew_required ?? null
  }
  if (options.configuration) item.configuration = options.configuration
  if (options.warning) item.warning = options.warning
  return item
}

export function sailPlanItem(candidate: SailCandidate | null, options: { configuration?: string | null; warning?: string | null } = {}): Record<string, unknown> | null {
  return planItemFrom(candidate, options)
}

export function recommendationFromCandidate(candidate: SailCandidate | null): Record<string, unknown> | null {
  if (!candidate) return null
  const warnings = [...candidate.warnings]
  return {
    sail_id: candidate.sail_id,
    sail_name: candidate.sail_name,
    sail_type: candidate.sail_type,
    crew_required: candidate.crew_required,
    crew_compatible: candidate.crew_compatible,
    confidence: confidenceForScore(candidate.score, warnings),
    reasons: [...candidate.reasons],
    warnings
  }
}

export function buildRecommendedSailPlan(options: {
  candidates: SailCandidate[]
  reefing: { status?: string | null }
  pointOfSail: string
  forecastTwsKnots: number
  forecastGustKnots: number
  availableCrewCount: number | null
  raceHeadsail?: { sail_id?: number | null; sail_name?: string | null } | null
  fixedHeadsailCandidate?: SailCandidate | null
  mainsailConfigurationOverride?: string | null
  jibChangesAllowed?: boolean
}): Record<string, unknown> | null {
  const { candidates } = options
  if (!candidates.length) return null
  const gustSpreadHigh = options.forecastGustKnots - options.forecastTwsKnots >= 10
  const compatible = candidates.filter((candidate) => candidate.crew_compatible)
  const mainsails = compatible.filter((candidate) => candidate.sail_category === 'mainsail')
  const trysails = compatible.filter((candidate) => candidate.sail_category === 'trysail')
  const primaryCategories = new Set(['headsail', 'reaching', 'downwind', 'mizzen_staysail'])
  const raceHeadsailId = int((options.raceHeadsail || {}).sail_id)
  const raceHeadsailName = (options.raceHeadsail || {}).sail_name
  let nonMains: SailCandidate[]
  if (raceHeadsailId !== null) {
    nonMains = compatible.filter((candidate) => primaryCategories.has(candidate.sail_category) && (!isRaceJib(candidate.sail_type) || candidate.sail_id === raceHeadsailId))
  } else {
    nonMains = compatible.filter((candidate) => primaryCategories.has(candidate.sail_category))
  }
  let headsails = nonMains.filter((candidate) => candidate.sail_category === 'headsail')
  if (options.fixedHeadsailCandidate && raceHeadsailId !== null && !headsails.some((candidate) => candidate.sail_id === raceHeadsailId)) {
    headsails = [options.fixedHeadsailCandidate, ...headsails]
    nonMains = [options.fixedHeadsailCandidate, ...nonMains]
  }
  const performanceSails = nonMains.filter((candidate) => candidate.sail_category === 'reaching' || candidate.sail_category === 'downwind')
  const crewShort = candidates.filter((candidate) => !candidate.crew_compatible)

  const mainsail = mainsails[0] ?? null
  const configuration = options.mainsailConfigurationOverride || mainsailConfiguration(options.reefing, { trysailAvailable: trysails.length > 0 })
  let primary = nonMains[0] ?? null
  let optionalPerformance: SailCandidate | null = null
  let conservative = headsails[0] ?? primary
  const warnings: string[] = []
  const reasons: string[] = []

  if (mainsail) reasons.push('Mainsail selected as base sail.')
  else warnings.push('No active mainsail is available for this vessel.')

  if (raceHeadsailId !== null) {
    if (options.fixedHeadsailCandidate) {
      reasons.push(options.jibChangesAllowed ? `${raceHeadsailName} selected for this leg.` : `${raceHeadsailName} selected as the fixed race jib.`)
    } else if (raceHeadsailName) {
      warnings.push(`Race jib ${raceHeadsailName} is selected for the race but is outside this leg's configured range.`)
    }
  }

  if (gustSpreadHigh) warnings.push('High gust spread; sail selection still uses forecast wind speed. Use skipper judgement.')

  if ((options.pointOfSail === 'broad reach' || options.pointOfSail === 'running') && performanceSails.length) {
    primary = performanceSails[0]!
    conservative = headsails[0] ?? null
  } else if (primary) {
    reasons.push('Non-mainsail selected using apparent wind and configured sail ranges.')
  }

  if (optionalPerformance === null && performanceSails.length && primary !== performanceSails[0]) optionalPerformance = performanceSails[0]!
  if (!primary) warnings.push('No suitable headsail or downwind sail was found; plan is main-only.')

  for (const candidate of crewShort) {
    warnings.push(`${candidate.sail_name} requires ${candidate.crew_required} crew; only ${options.availableCrewCount} available.`)
  }

  const warningCandidates: Array<SailCandidate | null> = [mainsail, primary, optionalPerformance]
  if (options.fixedHeadsailCandidate && warningCandidates.every((candidate) => !candidate || candidate.sail_id !== options.fixedHeadsailCandidate!.sail_id)) {
    warningCandidates.push(options.fixedHeadsailCandidate)
  }
  for (const candidate of warningCandidates) {
    if (candidate) warnings.push(...candidate.warnings)
  }

  let optionalWarning: string | null = null
  if (optionalPerformance && optionalPerformance.warnings.length) {
    optionalWarning = 'Review sail warnings before selecting this performance option.'
  }

  const configurationLabel = MAINSAIL_CONFIGURATION_LABELS[configuration] ?? 'Full main'
  let summaryParts = [configurationLabel]
  if (primary) summaryParts.push(String(primary.sail_name || 'headsail'))
  else if (!mainsail && candidates.length) summaryParts = [String(candidates[0]!.sail_name || 'Sail')]
  const scoreBasis = primary ?? mainsail ?? candidates[0]!
  const confidence = confidenceForScore(scoreBasis.score, warnings)
  const crewRequiredValues = [mainsail, primary]
    .filter((candidate): candidate is SailCandidate => candidate !== null)
    .map((candidate) => candidate.crew_required)
    .filter((value): value is number => value !== null)

  return {
    mainsail: sailPlanItem(mainsail, { configuration }),
    mainsail_configuration: configuration,
    race_headsail: planItemFrom(options.raceHeadsail ?? null),
    jib_changes_allowed: options.jibChangesAllowed ?? false,
    headsail_or_downwind_sail: sailPlanItem(primary),
    optional_performance_sail: sailPlanItem(optionalPerformance, { warning: optionalWarning }),
    conservative_alternative: sailPlanItem(conservative),
    summary: summaryParts.join(' + '),
    crew_required_max: crewRequiredValues.length ? Math.max(...crewRequiredValues) : null,
    confidence,
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)]
  }
}