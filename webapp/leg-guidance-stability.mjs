const finite = value => typeof value === 'number' && Number.isFinite(value)
const roles = ['mainsail', 'race_headsail', 'headsail_or_downwind_sail']
const critical = warnings => (warnings || []).filter(w => typeof w === 'string' && /exceed|sail limit|reef|trysail|(?:AWS|TWS).*above/i.test(w))
const rank = plan => ({ full_main: 0, reef_1: 1, reef_2: 2, reef_3: 3, trysail_consideration: 4 }[plan?.mainsail_configuration || plan?.mainsail?.configuration] ?? 0)
const identity = plan => plan ? JSON.stringify([plan.mainsail_configuration, ...roles.map(role => plan[role]?.sail_id ?? plan[role]?.sail_name ?? null), roles.some(role => plan[role]) ? null : plan.summary]) : null

/** Per-view presentation state. Engine inputs and persisted calculations stay immutable. */
export class LegGuidanceStabilizer {
  context = null
  states = new Map()
  reset() { this.context = null; this.states.clear() }

  update(context, legs, at) {
    if (context !== this.context) { this.reset(); this.context = context }
    const present = new Set()
    const result = legs.map((leg, index) => {
      const snake = Object.hasOwn(leg, 'awa_deg')
      const awaField = snake ? 'awa_deg' : 'awaDeg'
      const awsField = snake ? 'aws_knots' : 'awsKnots'
      const planField = snake ? 'recommended_sail_plan' : 'plan'
      const plan = leg[planField]
      const candidates = leg.candidateSails ?? leg.candidate_sails
      const source = leg.conditions?.source ?? leg.forecast_source ?? ''
      const side = leg.windSide ?? leg.wind_side ?? ''
      const target = leg.to ?? leg.to_waypoint
      const key = JSON.stringify([leg.sequence ?? index, target?.name, target?.latitude, target?.longitude, source, side])
      present.add(key)
      const awa = leg[awaField], aws = leg[awsField]
      const warnings = critical(plan?.warnings)
      if (!finite(at) || !finite(awa) || awa < 0 || awa > 180 || !finite(aws) || aws < 0) {
        this.states.delete(key)
        return { ...leg, guidanceStability: { pendingSailChange: false, warnings } }
      }
      let state = this.states.get(key)
      if (!state || at < state.at || at - state.at > 30000) {
        state = { at, awa, aws, shownAwa: awa, shownAws: aws, plan: structuredClone(plan), pending: null }
        this.states.set(key, state)
      } else {
        const alpha = 1 - Math.exp(-(at - state.at) / 15000)
        state.awa += alpha * (awa - state.awa)
        state.aws += alpha * (aws - state.aws)
        if (Math.abs(state.awa - state.shownAwa) >= 1) state.shownAwa = state.awa
        if (Math.abs(state.aws - state.shownAws) >= 0.2) state.shownAws = state.aws
        state.at = at
      }
      const heldIds = new Set(roles.map(role => state.plan?.[role]?.sail_id).filter(id => id != null))
      const heldCandidates = Array.isArray(candidates) ? candidates.filter(candidate => heldIds.has(candidate.sail_id)) : []
      const heldWarnings = heldCandidates.flatMap(candidate => critical(candidate.warnings))
      const unavailable = Array.isArray(candidates) && [...heldIds].some(id => !candidates.some(candidate => candidate.sail_id === id && candidate.crew_compatible !== false))
      const urgent = !plan || !state.plan || rank(plan) > rank(state.plan) || unavailable || heldWarnings.length > 0
      if (urgent || identity(plan) === identity(state.plan)) {
        state.plan = structuredClone(plan)
        state.pending = null
      } else if (!state.pending || state.pending.id !== identity(plan)) {
        state.pending = { id: identity(plan), at }
      } else if (at - state.pending.at >= 30000) {
        state.plan = structuredClone(plan)
        state.pending = null
      }
      const displayedPlan = state.plan ? { ...structuredClone(state.plan), warnings: [...new Set([...(plan?.warnings || []), ...heldWarnings])] } : plan
      return { ...leg, [awaField]: state.shownAwa, [awsField]: state.shownAws, [planField]: displayedPlan,
        guidanceStability: { pendingSailChange: !!state.pending, warnings: [...new Set([...warnings, ...heldWarnings])] } }
    })
    for (const key of this.states.keys()) if (!present.has(key)) this.states.delete(key)
    return result
  }
}
