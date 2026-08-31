import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const forbidden = [
  { name: 'private IPv4 address', pattern: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})\b/i },
  { name: 'Wake Logger non-production hostname', pattern: /\b(?:dev|test|staging|stage|qa)[.-][a-z0-9.-]*wakelogger|\b[a-z0-9.-]*(?:dev|test|staging|stage|qa)\.wakelogger\./i },
  { name: 'private workspace path', pattern: /\/(?:home|Users)\/[a-z0-9._-]+\/(?:\.openclaw|workspace|Downloads)\b/i },
  { name: 'private vessel fixture name', pattern: new RegExp(`\\b${['Call', 'isto'].join('')}\\b`, 'i') }
]

const failures = []
for (const file of files) {
  if (file === 'package-lock.json') continue
  let contents
  try {
    contents = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const rule of forbidden) if (rule.pattern.test(contents)) failures.push(`${file}: ${rule.name}`)
}

if (failures.length) {
  console.error(`Public repository safety check failed:\n${failures.map((item) => `- ${item}`).join('\n')}`)
  process.exit(1)
}
