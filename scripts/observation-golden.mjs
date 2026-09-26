// Deterministic CLI for the shared raw-observation golden fixture.
//
// Usage: node scripts/observation-golden.mjs <input.json>
// Prints the plugin's aggregateObservationWindow result as canonical JSON.
// Requires a prior `npx tsc -p tsconfig.build.json`.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const { aggregateRawObservationWindow } = await import(path.join(here, '..', 'dist', 'race', 'observation-window.js'))

const input = process.argv[2]
if (!input) {
  process.stderr.write('usage: node scripts/observation-golden.mjs <input.json>\n')
  process.exit(2)
}
const fixture = JSON.parse(readFileSync(input, 'utf8'))
const now = Date.parse(fixture.now)
const samples = fixture.samples.map((sample) => ({ ...sample, at: Date.parse(sample.at) }))
const result = aggregateRawObservationWindow(samples, now)
process.stdout.write(JSON.stringify({ ...result.averages, position: result.position, readiness: result.readiness }))
