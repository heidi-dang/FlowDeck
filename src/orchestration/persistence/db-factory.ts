/**
 * Canonical database factory — returns a FlowDbAdapter for the current runtime.
 */

import { createRequire } from 'node:module'
import type { FlowDbAdapter } from './db-adapter'
import { REQUIRED_PRAGMAS } from './configuration'

const _require = createRequire(import.meta.url)

export type DbBackend = 'bun' | 'node'

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

export function _resetBackendCache(): void {
  _detectedBackend = null
}

function applyPragmas(adapter: FlowDbAdapter): void {
  for (const p of REQUIRED_PRAGMAS) {
    adapter.exec(`PRAGMA ${p.name} = ${p.value}`)
  }
}

function makeBunAdapter(path: string): FlowDbAdapter {
  const { Database } = _require('bun:sqlite') as any
  const db = new Database(path, { create: true })
  return {
    exec(sql: string): void { db.run(sql) },
    prepare<T>(sql: string) {
      const stmt = db.query(sql)
      return {
        run(...params: any[]): void { (stmt as any).run(...params) },
        get(...params: any[]): T | undefined | null { return ((stmt as any).get(...params) as T) ?? null },
        all(...params: any[]): T[] { return (stmt as any).all(...params) as T[] },
        finalize(): void { (stmt as any).finalize() },
      }
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)()
    },
    close(): void { db.close() },
  }
}

function makeNodeAdapter(path: string): FlowDbAdapter {
  const { DatabaseSync } = _require('node:sqlite') as any
  const db = new DatabaseSync(path, { open: true })
  return {
    exec(sql: string): void { db.exec(sql) },
    prepare<T>(sql: string) {
      const stmt = db.prepare(sql)
      return {
        run(...params: any[]): void { (stmt as any).run(...params) },
        get(...params: any[]): T | undefined | null {
          return ((stmt as any).get(...params) as T) ?? null
        },
        all(...params: any[]): T[] { return (stmt as any).all(...params) as T[] },
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

export function openDb(path: string, backend?: DbBackend): FlowDbAdapter {
  const resolved = backend ?? detectBackend()
  const adapter = resolved === 'bun' ? makeBunAdapter(path) : makeNodeAdapter(path)
  applyPragmas(adapter)
  return adapter
}
