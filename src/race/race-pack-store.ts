import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseRacePack, racePackIdentity, type RacePack } from './pack'
import type { AppliedRacePack, RacePackManifest, RacePackStoreLike } from './race-pack-protocol'

interface StoredRacePackMeta {
  version: 1
  file: string
  packId: string | null
  revision: number
  sha256: string
  ruleSetVersion: string
  courseId: string
  racePlanId: number | null
  generatedAt: string
  validFrom: string | null
  validUntil: string | null
  appliedAt: number
}

export interface RacePackStoreStatus {
  applied: AppliedRacePack | null
  storedAt: number | null
}

function safeFileName(packId: string | null, revision: number): string {
  const identity = (packId ?? 'pack').replace(/[^A-Za-z0-9._-]/g, '_')
  return `${identity}-${revision}.bin`
}

// Persists validated packs under the plugin data directory. Packs are written
// to immutable, versioned files and only then referenced by an atomically
// replaced metadata document, so a crash can never replace a known-good pack
// with an incomplete one.
export class RacePackStore implements RacePackStoreLike {
  private meta?: StoredRacePackMeta
  private pack?: RacePack
  private operation: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string) {}

  async open(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.metaPath(), 'utf8')) as StoredRacePackMeta
      if (raw.version !== 1 || typeof raw.file !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(raw.file)) throw new Error('race_pack_meta_invalid')
      if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error('race_pack_meta_invalid')
      const bytes = await fs.readFile(path.join(this.directory, raw.file))
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== raw.sha256) throw new Error('race_pack_digest_invalid')
      const pack = parseRacePack(bytes)
      const identity = racePackIdentity(pack)
      if (identity.revision !== raw.revision) throw new Error('race_pack_identity_invalid')
      this.meta = raw
      this.pack = pack
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      // A corrupt stored pack must not crash Signal K. Keep the files for
      // inspection but expose no applied pack so a fresh download can replace it.
      this.meta = undefined
      this.pack = undefined
    }
  }

  applied(): AppliedRacePack | null {
    if (!this.meta) return null
    const identity = racePackIdentity(this.pack as RacePack)
    return { ...identity, revision: this.meta.revision, sha256: this.meta.sha256, appliedAt: this.meta.appliedAt }
  }

  current(): RacePack | null { return this.pack ?? null }

  status(): RacePackStoreStatus {
    return { applied: this.applied(), storedAt: this.meta?.appliedAt ?? null }
  }

  apply(entry: { bytes: Buffer; pack: RacePack; manifest: RacePackManifest; appliedAt: number }): Promise<boolean> {
    const operation = this.operation.then(async () => {
      const currentMeta = this.meta
      if (currentMeta) {
        // Revision is the monotonic pack version. A lower revision is stale and
        // must never roll the usable pack back; the same revision is only a
        // no-op when it is byte-for-byte the same immutable pack.
        if (entry.manifest.revision < currentMeta.revision) return false
        if (entry.manifest.revision === currentMeta.revision) {
          return currentMeta.packId === entry.manifest.packId && currentMeta.sha256 === entry.manifest.sha256
        }
      }
      const file = safeFileName(entry.manifest.packId, entry.manifest.revision)
      const digest = createHash('sha256').update(entry.bytes).digest('hex')
      if (digest !== entry.manifest.sha256) throw new Error('race_pack_digest_invalid')
      const identity = racePackIdentity(entry.pack)
      const next: StoredRacePackMeta = {
        version: 1,
        file,
        packId: entry.manifest.packId,
        revision: entry.manifest.revision,
        sha256: digest,
        ruleSetVersion: identity.ruleSetVersion,
        courseId: identity.courseId,
        racePlanId: identity.racePlanId,
        generatedAt: identity.generatedAt,
        validFrom: identity.validFrom,
        validUntil: identity.validUntil,
        appliedAt: entry.appliedAt
      }
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      await this.writeFileAtomic(path.join(this.directory, file), entry.bytes)
      await this.writeMeta(next)
      const previousFile = currentMeta?.file
      this.meta = next
      this.pack = entry.pack
      if (previousFile && previousFile !== file) await fs.rm(path.join(this.directory, previousFile), { force: true }).catch(() => undefined)
      return true
    })
    this.operation = operation.then(() => undefined, () => undefined)
    return operation
  }

  async close(): Promise<void> { await this.operation }

  private metaPath(): string { return path.join(this.directory, 'current.json') }

  private async writeMeta(meta: StoredRacePackMeta): Promise<void> {
    await this.writeFileAtomic(this.metaPath(), Buffer.from(`${JSON.stringify(meta)}\n`, 'utf8'))
  }

  private async writeFileAtomic(target: string, bytes: Buffer): Promise<void> {
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    const handle = await fs.open(temporary, 'w', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, target)
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(target), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
}
