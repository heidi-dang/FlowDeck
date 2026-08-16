/**
 * Canonical database factory — returns a FlowDbAdapter for the current runtime.
 *
 * Detection order:
 *   1. Explicit override: `openDb(path, 'bun' | 'node')`
 *   2. Auto-detect: tries to import bun:sqlite; falls back to node:sqlite.
 *
 * Both implementations apply identical PRAGMAs preserving WAL, foreign_keys,
 * busy_timeout, synchronous, cache_size, and journal_size_limit semantics.
 *
 * Use openDb() — never import runtime Database constructors directly in
 * FlowDeck persistence code.
 */

import { createRequire } from 'node:module'
import type { FlowDbAdapter } from './db-adapter.ts'
import { REQUIRED_PRAGMAS } from './configuration.ts'

// createRequire gives us a CJS-compatible require() even in ESM context.
// Used for lazy-loading bun:sqlite or node:sqlite without static imports.
const _require = createRequire(import.meta.url)

/** Supported backend identifiers. */
export type DbBackend = 'bun' | 'node'

/**
 * Detect which backend is available in the current runtime.
 * Returns 'bun' when bun:sqlite is loadable, 'node' otherwise.
 * Cached after first call.
 */
let _detectedBackend: DbBackend | null = null
export function detectBackend(): DbBackend {
  if (_detectedBackend) return _detectedBackend
  try {
    _require('bun:sqlite')
    _detectedBackend = 'bun'
  } catch {
    _detectedBackend = 'node'
  }
  return _detectedBackend
}

/** Reset the cached backend detection. Test-only. */
export function _resetBackendCache(): void {
  _detectedBackend = null
}

function applyPragmas(adapter: FlowDbAdapter): void {
  for (const p of REQUIRED_PRAGMAS) {
    adapter.exec(`PRAGMA ${p.name} = ${p.value}`)
  }
}

function makeBunAdapter(path: string): FlowDbAdapter {
  const { Database } = _require('bun:sqlite') as typeof import('bun:sqlite')
  const db = new Database(path, { create: true })
  return {
    exec(sql: string): void { db.run(sql) },
    prepare<T>(sql: string) {
      const stmt = db.query<T, unknown[]>(sql)
      return {
        run(...params: unknown[]): void { stmt.run(...params as Parameters<typeof stmt.run>) },
        get(...params: unknown[]): T | undefined | null { return stmt.get(...params as Parameters<typeof stmt.get>) ?? null },
        all(...params: unknown[]): T[] { return stmt.all(...params as Parameters<typeof stmt.all>) },
        finalize(): void { stmt.finalize() },
      }
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)()
    },
    close(): void { db.close() },
  }
}

function makeNodeAdapter(path: string): FlowDbAdapter {
  const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(path, { open: true })
  return {
    exec(sql: string): void { db.exec(sql) },
    prepare<T>(sql: string) {
      const stmt = db.prepare(sql)
      return {
        run(...params: unknown[]): void { stmt.run(...params) },
        get(...params: unknown[]): T | undefined | null {
          return (stmt.get(...params) as T) ?? null
        },
        all(...params: unknown[]): T[] { return stmt.all(...params) as T[] },
      }
    },
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (err) {
        try { db.exec('ROLLBACK') } catch { /* connection may be unusable */ }
        throw err
      }
    },
    close(): void { db.close() },
  }
}

/**
 * Open a database at `path` using the detected (or forced) backend.
 * Applies all required PRAGMAs before returning.
 *
 * @param path  Absolute file path or ':memory:'
 * @param backend  Force backend; auto-detected when omitted
 */
export function openDb(path: string, backend?: DbBackend): FlowDbAdapter {
  const resolved = backend ?? detectBackend()
  const adapter = resolved === 'bun' ? makeBunAdapter(path) : makeNodeAdapter(path)
  applyPragmas(adapter)
  return adapter
}
