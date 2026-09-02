import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

interface PackageMetadata {
  name: string
  version: string
  signalk?: {
    appIcon?: string
    screenshots?: string[]
  }
}

const root = process.cwd()
const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageMetadata

describe('release metadata', () => {
  it('pins App Store screenshots to this immutable npm version and packages the corresponding files', () => {
    const prefix = `https://unpkg.com/${metadata.name}@${metadata.version}/`
    expect(metadata.signalk?.screenshots?.length).toBeGreaterThan(0)

    for (const screenshot of metadata.signalk?.screenshots ?? []) {
      expect(screenshot.startsWith(prefix)).toBe(true)
      expect(existsSync(path.join(root, screenshot.slice(prefix.length)))).toBe(true)
    }
  })

  it('packages the declared App Store icon', () => {
    const icon = metadata.signalk?.appIcon?.replace(/^(?:\.?\/)+/, '')
    expect(icon).toBeTruthy()
    expect(existsSync(path.join(root, icon ?? ''))).toBe(true)
  })
})
