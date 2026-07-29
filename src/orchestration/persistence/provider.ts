/**
 * Database provider boundary — Dev 1 owned.
 * Persistence-domain code should use this interface rather than depending
 * directly on better-sqlite3 types.
 */

export interface SqlDb {
  exec(sql: string): void
  prepare(sql: string): SqlStmt
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T
  pragma(name: string, options?: { simple?: boolean }): unknown
  close(): void
}

export interface SqlStmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
}
