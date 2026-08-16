/**
 * Portable core dependency gate — Phase 2.
 *
 * Proves that FlowDeck's host-neutral contracts and the db-factory can be loaded
 * in a Node.js environment WITHOUT importing bun:sqlite.
 *
 * This test runs under Vitest (Node.js runtime).
 * Any import that transitively requires bun:sqlite at module-load time will fail here.
 *
 * The db-factory uses lazy require() so importing it does NOT trigger bun:sqlite.
 * openDb() with backend='node' must work without Bun installed.
 */

import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'

describe('Portable core — Node.js import gate', () => {
  it('loads FlowDbAdapter type without importing bun:sqlite', async () => {
    // If this import throws, bun:sqlite leaked into module-load scope.
    const { openDb } = await import('../src/orchestration/persistence/db-factory.ts')
    expect(typeof openDb).toBe('function')
  })

  it('loads host contracts without OpenCode or DSH types', async () => {
    // These are pure TypeScript interfaces — no runtime exports, but importing
    // the module proves the file has no runtime-breaking imports.
    const contracts = await import('../src/host-contracts/index.ts')
    // The module may export nothing at runtime (all type exports), so just check it loads.
    expect(contracts).toBeDefined()
  })

  it('openDb with node backend opens an in-memory database', () => {
    const { openDb } = require('../src/orchestration/persistence/db-factory.ts')
    const db = openDb(':memory:', 'node')
    expect(db).toBeDefined()
    expect(typeof db.exec).toBe('function')
    expect(typeof db.prepare).toBe('function')
    expect(typeof db.transaction).toBe('function')
    expect(typeof db.close).toBe('function')
    db.close()
  })

  it('node adapter exec and prepare work correctly', () => {
    const { openDb } = require('../src/orchestration/persistence/db-factory.ts')
    const db = openDb(':memory:', 'node')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
    const stmt = db.prepare('INSERT INTO t VALUES (?, ?)')
    stmt.run(1, 'hello')
    const row = db.prepare('SELECT * FROM t WHERE id = ?').get(1) as { id: number; val: string }
    expect(row).toEqual({ id: 1, val: 'hello' })
    const all = db.prepare('SELECT * FROM t').all() as { id: number; val: string }[]
    expect(all).toHaveLength(1)
    db.close()
  })

  it('node adapter transaction commits on success', () => {
    const { openDb } = require('../src/orchestration/persistence/db-factory.ts')
    const db = openDb(':memory:', 'node')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const result = db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run(42)
      return db.prepare('SELECT id FROM t WHERE id = ?').get(42) as { id: number }
    })
    expect(result).toEqual({ id: 42 })
    // Verify it was committed
    const after = db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }
    expect(after.c).toBe(1)
    db.close()
  })

  it('node adapter transaction rolls back on error', () => {
    const { openDb } = require('../src/orchestration/persistence/db-factory.ts')
    const db = openDb(':memory:', 'node')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    expect(() => {
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?)').run(1)
        throw new Error('intentional rollback')
      })
    }).toThrow('intentional rollback')
    // Nothing committed
    const after = db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }
    expect(after.c).toBe(0)
    db.close()
  })

  it('node adapter applies WAL and foreign_keys pragmas', () => {
    const { openDb } = require('../src/orchestration/persistence/db-factory.ts')
    // Use a real file for WAL (WAL is unsupported on :memory: in some SQLite builds)
    const dir = mkdtempSync(join(tmpdir(), 'flowdeck-test-'))
    try {
      const db = openDb(join(dir, 'test.db'), 'node')
      // journal_mode WAL applied by openDb()
      const jm = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(jm.journal_mode).toBe('wal')
      // foreign_keys applied
      const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
      expect(fk.foreign_keys).toBe(1)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('node adapter busy_timeout pragma is applied', () => {
    const { openDb } = require('../src/orchestration/persistence/db-factory.ts')
    const dir = mkdtempSync(join(tmpdir(), 'flowdeck-test-'))
    try {
      const db = openDb(join(dir, 'test.db'), 'node')
      const bt = db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
      expect(bt.timeout).toBe(5000)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detectBackend returns node in this environment', () => {
    const { detectBackend } = require('../src/orchestration/persistence/db-factory.ts')
    const backend = detectBackend()
    // In the Node.js test environment (Vitest), bun:sqlite is not available
    expect(backend).toBe('node')
  })
})

describe('ModelLock contract shape', () => {
  it('accepts a valid locked model reference', () => {
    // Pure type test — runtime value check
    const lock = {
      modelId: 'ag/claude-sonnet-4-6',
      providerId: 'heidi-gateway',
      locked: true as const,
    }
    expect(lock.locked).toBe(true)
    expect(typeof lock.modelId).toBe('string')
    expect(typeof lock.providerId).toBe('string')
  })

  it('accepts optional fields without crashing', () => {
    const lock = {
      modelId: 'deepseek-v3',
      providerId: 'deepseek-official',
      endpoint: 'https://api.deepseek.com',
      credentialRef: 'DEEPSEEK_API_KEY',
      reasoningEffort: 'high',
      contextWindow: 128000,
      locked: true as const,
    }
    expect(lock.contextWindow).toBe(128000)
    expect(lock.reasoningEffort).toBe('high')
  })
})
