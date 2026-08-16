/**
 * FlowDbAdapter — host-neutral SQLite interface.
 *
 * Models exactly the bun:sqlite Database API surface that FlowDeck's persistence
 * layer actually uses. Implementations exist for:
 *   - bun:sqlite (Bun/OpenCode runtime — default)
 *   - node:sqlite (Node.js/DSH runtime)
 *
 * Callers hold a FlowDbAdapter, never a runtime-specific Database directly.
 * The factory in `./db-factory.ts` returns the correct implementation based
 * on the runtime environment.
 *
 * Why a new interface rather than using bun:sqlite's Database type directly:
 *   bun:sqlite is not importable in Node.js — the import itself throws.
 *   Every module that `import type { Database } from "bun:sqlite"` is currently
 *   only safe because those imports are type-erased at runtime. If DSH tries to
 *   load any of those modules under Node.js they fail at the first db.transaction()
 *   or db.query() call. Injecting FlowDbAdapter breaks that coupling cleanly.
 */

/** A prepared statement handle. Returned by FlowDbAdapter.prepare(). */
export interface FlowStmt<T = unknown> {
  /** Run the statement with bound parameters. Returns the statement (fluent). */
  run(...params: unknown[]): void
  /** Return the first matching row, or null/undefined when absent. */
  get(...params: unknown[]): T | undefined | null
  /** Return all matching rows. */
  all(...params: unknown[]): T[]
  /** Free native resources. Optional; implementations may no-op. */
  finalize?(): void
}

/**
 * Host-neutral database adapter.
 * Mirrors the bun:sqlite Database API that FlowDeck's persistence layer uses.
 * Both implementations are synchronous — FlowDeck's transaction semantics require sync.
 */
export interface FlowDbAdapter {
  /** Execute one or more SQL statements (DDL, PRAGMA, BEGIN/COMMIT/ROLLBACK). */
  exec(sql: string): void

  /**
   * Prepare a SQL statement for repeated execution.
   * Equivalent to bun:sqlite's db.query() or db.prepare().
   */
  prepare<T = unknown>(sql: string): FlowStmt<T>

  /**
   * Execute fn() inside a database transaction.
   * If fn throws the transaction is rolled back; on success it is committed.
   * Equivalent to bun:sqlite's db.transaction(fn)().
   *
   * Note: implementations must use explicit BEGIN/COMMIT/ROLLBACK internally
   * because node:sqlite's DatabaseSync does not expose a .transaction() helper.
   */
  transaction<T>(fn: () => T): T

  /** Close the database connection. */
  close(): void
}
