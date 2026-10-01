// Minimal ambient types for better-sqlite3 (no @types package is installed).
declare module 'better-sqlite3' {
  interface RunResult {
    changes: number
    lastInsertRowid: number | bigint
  }
  interface Statement {
    run(...params: unknown[]): RunResult
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  interface Database {
    prepare(sql: string): Statement
    exec(sql: string): this
    pragma(source: string, options?: { simple?: boolean }): unknown
    close(): void
  }
  interface DatabaseConstructor {
    new (file: string): Database
  }
  const Database: DatabaseConstructor
  export default Database
}
