// Deterministic CLI entry point for the cross-repo race-plan parity harness.
//
// Usage: node scripts/dynamic-golden.mjs <input.json>
// Prints the computeDynamicPlan result as canonical JSON on stdout. Requires a
// prior `npx tsc -p tsconfig.build.json` so dist/race/dynamic.js exists.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const { computeDynamicPlan } = await import(path.join(here, '..', 'dist', 'race', 'dynamic.js'))

const input = process.argv[2]
if (!input) {
  process.stderr.write('usage: node scripts/dynamic-golden.mjs <input.json>\n')
  process.exit(2)
}
const document = JSON.parse(readFileSync(input, 'utf8'))
process.stdout.write(JSON.stringify(computeDynamicPlan(document)))
