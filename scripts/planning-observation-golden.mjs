import { readFileSync } from 'node:fs'
import { selectPlanningObservations } from '../dist/race/observation-window.js'
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const selected = selectPlanningObservations(input.samples.map(sample => ({ ...sample, at: Date.parse(sample.at) })), Date.parse(input.now))
console.log(JSON.stringify(selected ? { basis: selected.basis, tws: selected.averages.twsKnots, twd: selected.averages.twdDeg, gust: selected.averages.gustKnots } : null))
