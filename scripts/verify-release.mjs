import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (typeof packageJson.version !== 'string' || !/-beta\.[0-9]+$/.test(packageJson.version)) {
  throw new Error('Only -beta.N package versions may be published by the current release process')
}
if (process.env.npm_config_tag !== 'beta') {
  throw new Error('Refusing publication without the explicit npm --tag beta option')
}

let gitStatus
try {
  const insideWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()
  if (insideWorkTree !== 'true') throw new Error('not inside a Git worktree')
  execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' })
  gitStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { encoding: 'utf8' }).trim()
} catch (error) {
  throw new Error(`Release must be published from a Git checkout with a valid HEAD: ${error instanceof Error ? error.message : String(error)}`)
}
if (gitStatus) {
  throw new Error('Release must be published from a clean Git checkout so npm can attach an authoritative gitHead')
}
