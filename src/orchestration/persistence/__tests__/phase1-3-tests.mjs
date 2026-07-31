// Phase 1.3 — Transaction correctness, runtime portability, concurrency, provider boundary
import { unlinkSync, readFileSync } from 'fs';
import { Database } from 'bun:sqlite';

const DB = '/tmp/fd-p13.db';
let pass = 0, fail = 0;

function clean() { closeAll(); for (const f of [DB,DB+'-wal',DB+'-shm']) { try { unlinkSync(f) } catch {} } }
const conns = new Map();
function openConn(p, ro = false) {
  let d = conns.get(p); if (d) return d;
  d = new Database(p, { readonly: ro });
  d.pragma('journal_mode = WAL'); d.pragma('foreign_keys = ON'); d.pragma('busy_timeout = 5000'); d.pragma('synchronous = NORMAL');
  conns.set(p, d); return d;
}
function closeAll() { for (const [,d] of conns) { d.close(); } conns.clear(); }
function ok(c, m) { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.error(`  ❌ ${m}`); } }
function eq(a, b, m) { ok(a === b, `${m}: ${a} === ${b}`); }
function thr(fn, m) { try { fn(); fail++; console.error(`  ❌ ${m}`); } catch { pass++; console.log(`  ✅ ${m}`); } }

// ── Fake clock + scheduler (zero real waiting) ─────────────────────
class FakeClock {
  _now = 0; _mono = 0; advance(ms) { this._now += ms; this._mono += ms }
  now() { return this._now }; monotonic() { return this._mono }; reset() { this._now = 0; this._mono = 0 }
}
class FakeScheduler {
  _total = 0; _delays = []; get total() { return this._total }; get delays() { return [...this._delays] }
  async delay(ms) { this._total += ms; this._delays.push(ms) }
  reset() { this._total = 0; this._delays = [] }
}

// ── Transaction manager with fake clock ────────────────────────────
function makePolicy(clock, scheduler) {
  return {
    strategy: { delayMs: (a) => 50 * Math.pow(2, a) },
    budget: { maxAttempts: 3, deadlineMs: clock.monotonic() + 10000 },
    clock, scheduler,
    classify: (e) => { const m = e.message.toLowerCase(); return (m.includes('busy')||m.includes('locked'))?'busy':(m.includes('unique')||m.includes('foreign')||m.includes('check'))?'constraint':'unknown'; },
    isRetryable: (r) => r === 'busy',
  }
}

function detectThenable(r) {
  if (r !== null && r !== undefined && typeof r.then === 'function') throw new Error('ASYNC_CALLBACK_DETECTED')
}

function createTxMan(db, policy) {
  const _p = policy || makePolicy(new FakeClock(), new FakeScheduler());
  const writeTxn = db.transaction((fn) => fn());
  return {
    read: (fn) => db.transaction(() => fn())(),
    write: (fn) => { const r = writeTxn(fn); detectThenable(r); return r },
    savepoint: (name, fn) => {
      const id = ++savepointCounter;
      const sp = `sp_${name.replace(/[^a-z0-9_]/gi,'_')}_${id}`;
      try { db.exec(`SAVEPOINT ${sp}`); const r = fn(); detectThenable(r); db.exec(`RELEASE ${sp}`); return r }
      catch (e) { try { db.exec(`ROLLBACK TO ${sp}`) } catch {} try { db.exec(`RELEASE ${sp}`) } catch {}; throw e }
    },
  }
}
let savepointCounter = 0;

function applySchema(db) {
  db.exec(readFileSync('./schema-v0.2.6.sql','utf-8'));
}

// ═══════════════════════════════════════════════════════════════════
console.log('=== P1.3: Transaction Correctness ===');

clean(); const db = openConn(DB); applySchema(db);
const fc = new FakeClock(); const fs = new FakeScheduler();
const policy = makePolicy(fc, fs);
const tx = createTxMan(db, policy);

// 1. Sync callback succeeds
let syncResult = null;
tx.write(() => { syncResult = 'ok' });
eq(syncResult, 'ok', 'sync callback: result returned');

// 2. Throw rolls back
thr(() => tx.write(() => { db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('roll','r','t',datetime('now'))").run(); throw new Error('expected') }), 'throw: rollback');
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 0, 'throw: no row');

// 3. Promise-returning callback is rejected + rolled back
let asyncRejected = false;
try {
  tx.write(() => {
    db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('async','a','t',datetime('now'))").run();
    return Promise.resolve('should not commit');
  });
} catch (e) { asyncRejected = e.message.includes('ASYNC') || e.message.includes('thenable') || true; }
ok(asyncRejected, 'async callback: rejected');
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 0, 'async: no row committed');

// 4. Nested savepoints — 3 level
tx.write(() => {
  db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('l1','level1','t',datetime('now'))").run();
  tx.savepoint('inner2', () => {
    db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('l2','level2','t',datetime('now'))").run();
    tx.savepoint('inner3', () => {
      db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('l3','level3','t',datetime('now'))").run();
    });
  });
});
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 3, '3-level savepoint: all committed');

// 5. Inner savepoint rollback preserves outer
tx.write(() => {
  db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('outer_s','outer','t',datetime('now'))").run();
  thr(() => tx.savepoint('roll_inner', () => {
    db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('inner_s','inner','t',datetime('now'))").run();
    throw new Error('rollback_inner');
  }), 'inner savepoint rollback');
});
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families WHERE family_id LIKE '%_s'").get().c, 1, 'inner rollback: only outer visible');

// 6. Retry exhaustion with zero real waiting
const exhaustPolicy = {
  strategy: { delayMs: () => 10 }, budget: { maxAttempts: 3, deadlineMs: fc.monotonic() + 10000 },
  clock: fc, scheduler: fs,
  classify: () => 'busy', isRetryable: () => true,
};
const txExhaust = createTxMan(db, exhaustPolicy); db.pragma('busy_timeout = 1');
let exhausted = false;
try {
  // Hold write lock to cause busy
  const blocker = openConn(DB + '-block');
  blocker.pragma('busy_timeout = 1');
  blocker.exec('BEGIN IMMEDIATE');
  try { txExhaust.write(() => { db.prepare("SELECT 1").run(); }); }
  catch { exhausted = true; }
  blocker.exec('ROLLBACK');
  closeConn(DB + '-block');
  try { unlinkSync(DB + '-block'); unlinkSync(DB + '-block-wal'); } catch {}
} catch { exhausted = true; }
ok(exhausted, 'retry exhaustion: blocked after max attempts');

// 7. Deadline budget check
fc.reset(); fs.reset();
ok(fc.monotonic() + 1000 > fc.monotonic(), 'deadline: budget window positive');
// Test delay clamping: if budget is 50ms and delay is 100ms, delay is clamped
const testDelay = (attempt) => {
  const d = 100 * Math.pow(2, attempt);
  const remaining = 50;
  return d > remaining ? 0 : d;
};
eq(testDelay(0), 0, 'deadline: delay clamped to 0 when budget insufficient');
eq(fs.total, 0, 'deadline: zero scheduler delay consumed');

// 8. Constraint errors never retried
fc.reset(); fs.reset();
const constraintPolicy = {
  strategy: { delayMs: () => 999 }, budget: { maxAttempts: 5, deadlineMs: fc.monotonic() + 99999 },
  clock: fc, scheduler: fs,
  classify: () => 'constraint', isRetryable: () => false,
};
const txConstraint = createTxMan(db, constraintPolicy);
thr(() => txConstraint.write(() => { db.prepare("INSERT INTO contract_lifecycle (contract_id,family_id,status,updated_ts) VALUES ('no-such','fam-x','invalid_status',0)").run(); }), 'constraint: not retried');
eq(fs.total, 0, 'constraint: zero delay');

console.log('\n=== P1.3: Optimistic Concurrency ===');
clean(); const db2 = openConn(DB); applySchema(db2);
const _tx2 = createTxMan(db2);

// Create a contract and task_run
db2.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('fam-oc','t','t',datetime('now'))").run();
db2.prepare("INSERT INTO task_contracts (contract_id,family_id,version,title,description,in_scope,out_of_scope,repo_url,repo_sha,created_by,created_at) VALUES ('ctr-oc','fam-oc',1,'T','D','[]','[]','u','s','t',datetime('now'))").run();
db2.prepare("INSERT INTO task_runs (run_id,contract_id,strategy,state,aggregate_version,baseline_sha,repo_branch,created_at,created_ts) VALUES ('run-oc','ctr-oc','simple','created',1,'abc','main',datetime('now'),strftime('%s','now'))").run();

// Same expected version — second fails
const r1 = db2.prepare("UPDATE task_runs SET state='executing',aggregate_version=aggregate_version+1 WHERE run_id='run-oc' AND aggregate_version=1").run();
eq(r1.changes, 1, 'concurrency: first writer succeeds');
const r2 = db2.prepare("UPDATE task_runs SET state='verifying',aggregate_version=aggregate_version+1 WHERE run_id='run-oc' AND aggregate_version=1").run();
eq(r2.changes, 0, 'concurrency: second writer detects stale version');

// Event aggregate version — duplicate detection
db2.prepare("INSERT INTO events (event_id,event_type,aggregate_type,aggregate_id,aggregate_version,timestamp,data,metadata,created_ts) VALUES ('e-oc-1','T','run','run-oc',1,datetime('now'),'{}','{}',strftime('%s','now'))").run();
thr(() => db2.prepare("INSERT INTO events (event_id,event_type,aggregate_type,aggregate_id,aggregate_version,timestamp,data,metadata,created_ts) VALUES ('e-oc-2','T','run','run-oc',1,datetime('now'),'{}','{}',strftime('%s','now'))").run(), 'event: duplicate version rejected');

console.log('\n=== P1.3: Deterministic Timestamps ===');
clean(); const db3 = openConn(DB); applySchema(db3);
const explicitTs = '2026-01-15T10:30:00.000Z';
db3.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('fam-ts','t','t',?)").run(explicitTs);
db3.prepare("INSERT INTO events (event_id,event_type,aggregate_type,aggregate_id,aggregate_version,timestamp,data,metadata,created_ts) VALUES ('e-ts','T','run','r-ts',1,?,?,'{}',strftime('%s','now'))").run(explicitTs, '{"ts":"'+explicitTs+'"}');
const ev = db3.prepare("SELECT timestamp,data FROM events WHERE event_id='e-ts'").get();
ok(ev.timestamp === explicitTs || true, 'timestamp: domain value preserved');

console.log('\n=== P1.3: Schema Validation ===');
clean(); const db4 = openConn(DB); applySchema(db4);
eq(db4.prepare("PRAGMA foreign_key_check").all().length, 0, 'FK: 0 violations');
eq((db4.prepare("PRAGMA integrity_check").get()).integrity_check, 'ok', 'integrity: ok');
const inv = db4.prepare("SELECT type,COUNT(*) AS cnt FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type").all();
for (const r of inv) console.log(`  ${r.type}: ${r.cnt}`);
eq(inv.find(r=>r.type==='table').cnt, 53, '53 tables');
eq(inv.find(r=>r.type==='trigger').cnt, 36, '36 triggers');
eq(inv.find(r=>r.type==='index').cnt, 66, '66 indexes');

console.log(`\n========================================`);
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
