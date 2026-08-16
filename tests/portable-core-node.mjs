#!/usr/bin/env node
/**
 * Portable core Node.js gate — Phase 2.
 *
 * Proves that FlowDeck's db-factory and host contracts can be loaded and executed
 * in a pure Node.js environment without bun:sqlite.
 *
 * Run: node tests/portable-core-node.mjs
 * Exit 0 = PASS, Exit 1 = FAIL
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const results = []
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    results.push({ name, pass: true })
    process.stdout.write('  ✓ ' + name + '\n')
  } catch (err) {
    results.push({ name, pass: false, error: err.message })
    process.stdout.write('  ✗ ' + name + ': ' + err.message + '\n')
    failed++
  }
}

process.stdout.write('\nPortable core Node.js gate\n')
process.stdout.write('='.repeat(50) + '\n')

// ── 1. Module loading ──────────────────────────────────────────────────────
process.stdout.write('\n[1] Module loading\n')

await test('db-factory loads without bun:sqlite', async () => {
  const mod = await import('../src/orchestration/persistence/db-factory.ts')
  assert.equal(typeof mod.openDb, 'function')
  assert.equal(typeof mod.detectBackend, 'function')
})

await test('host-contracts/index loads without errors', async () => {
  // Type-only exports — module must not throw on load
  await import('../src/host-contracts/index.ts')
})

// ── 2. Backend detection ───────────────────────────────────────────────────
process.stdout.write('\n[2] Backend detection\n')

await test('detectBackend returns node in Node.js environment', async () => {
  const { detectBackend, _resetBackendCache } = await import('../src/orchestration/persistence/db-factory.ts')
  _resetBackendCache()
  const backend = detectBackend()
  assert.equal(backend, 'node', 'Expected node backend but got: ' + backend)
})

// ── 3. Node adapter — in-memory ────────────────────────────────────────────
process.stdout.write('\n[3] Node adapter (in-memory)\n')

await test('openDb node backend creates database', async () => {
  const { openDb } = await import('../src/orchestration/persistence/db-factory.ts')
  const db = openDb(':memory:', 'node')
  assert.equal(typeof db.exec, 'function')
  assert.equal(typeof db.prepare, 'function')
  assert.equal(typeof db.transaction, 'function')
  assert.equal(typeof db.close, 'function')
  db.close()
})

await test('exec + prepare + run + get + all work correctly', async () => {
  const { openDb } = await import('../src/orchestration/persistence/db-factory.ts')
  const db = openDb(':memory:', 'node')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
  db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'hello')
  const row = db.prepare('SELECT * FROM t WHERE id = ?').get(1)
  // node:sqlite returns [Object: null prototype] rows; spread to plain object for comparison
  assert.deepEqual({ ...row }, { id: 1, val: 'hello' })
  const all = db.prepare('SELECT * FROM t').all()
  assert.equal(all.length, 1)
  assert.deepEqual({ ...all[0] }, { id: 1, val: 'hello' })
  db.close()
})

await test('transaction commits on success', async () => {
  const { openDb } = await import('../src/orchestration/persistence/db-factory.ts')
  const db = openDb(':memory:', 'node')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
  const result = db.transaction(() => {
    db.prepare('INSERT INTO t VALUES (?)').run(42)
    return db.prepare('SELECT id FROM t WHERE id = ?').get(42)
  })
  assert.deepEqual({ ...result }, { id: 42 })
  const count = db.prepare('SELECT COUNT(*) AS c FROM t').get()
  assert.equal(count.c, 1)
  db.close()
})

await test('transaction rolls back on throw', async () => {
  const { openDb } = await import('../src/orchestration/persistence/db-factory.ts')
  const db = openDb(':memory:', 'node')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?)').run(1)
      throw new Error('rollback test')
    })
    assert.fail('Should have thrown')
  } catch (e) {
    assert.equal(e.message, 'rollback test')
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM t').get()
  assert.equal(count.c, 0, 'Transaction should have rolled back')
  db.close()
})

await test('nested exec (BEGIN IMMEDIATE / COMMIT) works inside transactions', async () => {
  const { openDb } = await import('../src/orchestration/persistence/db-factory.ts')
  const db = openDb(':memory:', 'node')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
  // Simulate FlowDeck TransactionManager.writeImmediate() pattern
  db.exec('BEGIN IMMEDIATE')
  db.prepare('INSERT INTO t VALUES (?)').run(99)
  db.exec('COMMIT')
  const row = db.prepare('SELECT id FROM t WHERE id = ?').get(99)
  assert.deepEqual({ ...row }, { id: 99 })
  db.close()
})

await test('SAVEPOINT patterns work', async () => {
  const { openDb } = await import('../src/orchestration/persistence/db-factory.ts')
  const db = openDb(':memory:', 'node')
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
  db.exec('BEGIN')
  db.exec('SAVEPOINT sp1')
  db.prepare('INSERT INTO t VALUES (?)').run(1)
  db.exec('RELEASE sp1')
  db.exec('SAVEPOINT sp2')
  db.prepare('INSERT INTO t VALUES (?)').run(2)
  db.exec('ROLLBACK TO sp2')
  db.exec('RELEASE sp2')
  db.exec('COMMIT')
  const all = db.prepare('SELECT id FROM t ORDER BY id').all()
  assert.deepEqual(all.map(r => r.id), [1])
  db.close()
})

// ── 4. Pragma verification (file-backed) ───────────────────────────────────
process.stdout.write('\n[4] PRAGMA verification (file-backed)\n')

await test('WAL, foreign_keys, busy_timeout pragmas applied', async () => {
  const { openDb } = await import('../src/orchestration/persistence/db-factory.ts')
  const dir = mkdtempSync(join(tmpdir(), 'flowdeck-gate-'))
  try {
    const db = openDb(join(dir, 'test.db'), 'node')
    const jm = db.prepare('PRAGMA journal_mode').get()
    assert.equal(jm.journal_mode, 'wal', 'Expected WAL mode')
    const fk = db.prepare('PRAGMA foreign_keys').get()
    assert.equal(fk.foreign_keys, 1, 'Expected foreign_keys=1')
    const bt = db.prepare('PRAGMA busy_timeout').get()
    assert.equal(bt.timeout, 5000, 'Expected busy_timeout=5000')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 5. Import surface check: no OpenCode/DSH/bun leakage ─────────────────
process.stdout.write('\n[5] Import surface\n')

await test('db-adapter.ts source has no bun:sqlite import', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/orchestration/persistence/db-adapter.ts', import.meta.url), 'utf8')
  assert.ok(!src.includes("from 'bun:sqlite'"), 'db-adapter.ts must not import bun:sqlite')
  assert.ok(!src.includes('@opencode-ai'), 'db-adapter.ts must not import opencode')
})

await test('host-contracts have no bun:sqlite or opencode imports', async () => {
  const { readFileSync } = await import('node:fs')
  const files = [
    '../src/host-contracts/model-lock.ts',
    '../src/host-contracts/child-session.ts',
    '../src/host-contracts/tool-definition.ts',
  ]
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.ok(!src.includes("bun:sqlite"), f + ' must not reference bun:sqlite')
    assert.ok(!src.includes('@opencode-ai'), f + ' must not reference opencode')
    assert.ok(!src.includes('@deepseek-ai'), f + ' must not reference DSH')
  }
})

// ── Summary ────────────────────────────────────────────────────────────────
process.stdout.write('\n' + '='.repeat(50) + '\n')
const passed = results.filter(r => r.pass).length
process.stdout.write(`Results: ${passed}/${results.length} passed\n`)

if (failed > 0) {
  process.stdout.write('\nFailed tests:\n')
  results.filter(r => !r.pass).forEach(r => process.stdout.write('  ✗ ' + r.name + ': ' + r.error + '\n'))
  process.exit(1)
} else {
  process.stdout.write('\nPASS — portable core is Node.js compatible\n')
  process.exit(0)
}
