import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const source = readFileSync(resolve(process.argv[2], 'frontend/app/lib/racePlanTiming.js'), 'utf8')
const f = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const snapshot = { planned_start_time: '2026-10-11T12:00:00Z' }
const first = { distance_nm: 1, estimated_sog_knots: 5, estimated_start_time: '2026-10-11T12:00:00Z', estimated_finish_time: '2026-10-15T16:00:00Z' }
const firstFinish = f.legEstimatedFinishTime(f.legEstimatedStartTime(snapshot, first, 0), first)
const elapsed = f.legDurationHours(first)
const derivedNext = f.legEstimatedStartTime(snapshot, { distance_nm: 1, estimated_sog_knots: 5 }, elapsed)
const explicitNext = f.legEstimatedStartTime(snapshot, { estimated_start_time: '2026-10-12T12:00:00Z' }, elapsed)
console.log(JSON.stringify({ firstFinish, derivedNext, explicitNext, orderedDerived: Date.parse(derivedNext) >= Date.parse(firstFinish), orderedExplicit: Date.parse(explicitNext) >= Date.parse(firstFinish) }, null, 2))
