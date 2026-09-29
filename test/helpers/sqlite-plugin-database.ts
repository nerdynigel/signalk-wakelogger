// A real, file-backed `PluginDatabase` for crash/durability tests.
//
// The Signal K Database API is only available inside a running Signal K server,
// so tests that need genuine commit/rollback and on-disk durability use SQLite
// via `better-sqlite3`. This is a real supported database engine, not an
// in-memory dictionary: WAL + synchronous=FULL so a "lost instance" can be
// reopened and its committed rows recovered.
import Database from 'better-sqlite3'
import type { DatabaseRunResult, PluginDatabase } from '../../src/outbox/database-types'

export class SqlitePluginDatabase implements PluginDatabase {
  private readonly db: InstanceType<typeof Database>

  constructor(file: string) {
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
