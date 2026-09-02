import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const expectedGitHead = process.env.EXPECTED_GIT_HEAD?.trim()

if (!expectedGitHead) throw new Error('EXPECTED_GIT_HEAD is required')

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const packageSegment = encodeURIComponent(packageJson.name).replace('%40', '@')
const metadataUrl = `https://registry.npmjs.org/${packageSegment}/${encodeURIComponent(packageJson.version)}`

let metadata
let lastError
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`)
    const candidate = await response.json()
    if (candidate.gitHead !== expectedGitHead) {
      throw new Error(`gitHead is ${candidate.gitHead ?? 'missing'}, expected ${expectedGitHead}`)
    }
    metadata = candidate
    break
  } catch (error) {
    lastError = error
    if (attempt < 12) await delay(5_000)
  }
}

if (!metadata) {
  throw new Error(`Published metadata did not converge: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

const declaredAssets = [metadata.signalk?.appIcon, ...(metadata.signalk?.screenshots ?? [])]
  .filter((value) => typeof value === 'string' && value.trim())

if (declaredAssets.length < 2 || !Array.isArray(metadata.signalk?.screenshots) || metadata.signalk.screenshots.length === 0) {
  throw new Error('Published Signal K metadata must include an app icon and at least one screenshot')
}

for (const declared of declaredAssets) {
  const url = /^https?:\/\//i.test(declared)
    ? declared
    : `https://unpkg.com/${packageJson.name}@${packageJson.version}/${declared.replace(/^(?:\.?\/)+/, '')}`
  const response = await fetch(url, {
    headers: { Range: 'bytes=0-31' },
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Published App Store asset returned HTTP ${response.status}: ${url}`)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Published App Store asset is not an image (${contentType || 'missing content type'}): ${url}`)
  }
}

console.log(`Verified ${packageJson.name}@${packageJson.version}: gitHead ${expectedGitHead} and ${declaredAssets.length} App Store images`)
