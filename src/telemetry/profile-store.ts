import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseTelemetryProfile, type TelemetryProfile } from './profile'

export class TelemetryProfileStore {
  private readonly target: string
  constructor(directory: string) { this.target = path.join(directory, 'telemetry-profile.json') }

  async load(): Promise<TelemetryProfile | undefined> {
    try { return parseTelemetryProfile(JSON.parse(await fs.readFile(this.target, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  async save(profile: TelemetryProfile): Promise<void> {
    await fs.mkdir(path.dirname(this.target), { recursive: true, mode: 0o700 })
    const temporary = `${this.target}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(profile)}\n`, { mode: 0o600 })
    const handle = await fs.open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, this.target)
    await fs.chmod(this.target, 0o600)
  }
}
