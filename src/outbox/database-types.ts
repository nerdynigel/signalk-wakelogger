export interface DatabaseRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface PluginDatabase {
  migrate(migrations: Array<{ version: number; sql: string }>): Promise<void>
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  run(sql: string, params?: unknown[]): Promise<DatabaseRunResult>
  transaction<T>(action: (database: PluginDatabase) => Promise<T>): Promise<T>
}

export interface SignalKDatabaseApi {
  getPluginDb(pluginId: string): Promise<PluginDatabase>
}

export interface WithSignalKDatabaseApi {
  getDatabaseApi?: () => SignalKDatabaseApi
}
