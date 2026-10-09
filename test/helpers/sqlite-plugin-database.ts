// A real, file-backed `PluginDatabase` for crash/durability tests.
//
// The Signal K Database API is only available inside a running Signal K server,
// so tests that need genuine commit/rollback and on-disk durability use SQLite
// via `better-sqlite3`. This is a real supported database engine, not an
// in-memory dictionary: WAL + synchronous=FULL so a "lost instance" can be
// reopened and its committed rows recovered.
//
// The native binding is built by install scripts (`npm rebuild better-sqlite3`,
// see `prepare:test-sqlite`). Environments that install with `--ignore-scripts`
// (for example the Signal K plugin registry harness) have no binding, so tests
// that need it must skip gracefully instead of failing. Callers check
// `betterSqlite3Available` and use `describe.skipIf`.
import { createRequire } from 'node:module'
import path from 'node:path'
import type DatabaseDefault from 'better-sqlite3'
import type { DatabaseRunResult, PluginDatabase } from '../../src/outbox/database-types'

type DatabaseCtor = typeof DatabaseDefault

// Works under both the CommonJS build and vitest's ESM transform.
const requireCjs = createRequire(path.join(process.cwd(), 'package.json'))

let Database: DatabaseCtor | null = null
let loadError: unknown = null
try {
  const loaded = requireCjs('better-sqlite3') as DatabaseCtor | { default?: DatabaseCtor }
  const candidate = (loaded as { default?: DatabaseCtor }).default ?? (loaded as DatabaseCtor)
  // The JS module always loads; constructing it is what fails when the native
  // binding was never built. Probe with an in-memory database and close it.
  const probe = new candidate(':memory:')
  probe.close()
  Database = candidate
} catch (error) {
  loadError = error
}

/** True when the `better-sqlite3` native binding can be loaded. */
export const betterSqlite3Available = Database !== null

/** The load failure, when `betterSqlite3Available` is false. */
export function betterSqlite3LoadError(): unknown {
  return loadError
}

export class SqlitePluginDatabase implements PluginDatabase {
  private readonly db: InstanceType<DatabaseCtor>

  constructor(file: string) {
    if (!Database) {
      throw new Error(
        'better-sqlite3 native binding is not available; run `npm run prepare:test-sqlite` ' +
          `before this suite. Cause: ${loadError instanceof Error ? loadError.message : String(loadError)}`
      )
    }
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
  }

  async migrate(migrations: Array<{ version: number; sql: string }>): Promise<void> {
    this.db.exec('CREATE TABLE IF NOT EXISTS plugin_schema_migrations (version INTEGER PRIMARY KEY)')
    const applied = new Set(
      (this.db.prepare('SELECT version FROM plugin_schema_migrations').all() as Array<{ version: number }>)
        .map((row) => Number(row.version))
    )
    for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
      if (applied.has(migration.version)) continue
      this.db.exec(migration.sql)
      this.db.prepare('INSERT INTO plugin_schema_migrations (version) VALUES (?)').run(migration.version)
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[]
  }

  async run(sql: string, params: unknown[] = []): Promise<DatabaseRunResult> {
    const result = this.db.prepare(sql).run(...params)
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
  }

  async transaction<T>(action: (database: PluginDatabase) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = await action(this)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Reported so a test can assert the actual durability boundary it exercised.
  durability(): Record<string, unknown> {
    return {
      journalMode: this.db.pragma('journal_mode', { simple: true }),
      synchronous: this.db.pragma('synchronous', { simple: true }),
      walAutocheckpoint: this.db.pragma('wal_autocheckpoint', { simple: true })
    }
  }

  close(): void {
    this.db.close()
  }
}
