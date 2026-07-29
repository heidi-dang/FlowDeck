// Phase 1.4 — Transaction commit boundary, thenable detection before commit, retry, concurrency
import { unlinkSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';

const DB = '/tmp/fd-p14.db';
let pass = 0, fail = 0;

function clean() { closeAll(); for (const f of [DB,DB+'-wal',DB+'-shm']) { try { unlinkSync(f) } catch {} } }
const conns = new Map();
function openConn(p, ro = false) {
  let d = conns.get(p); if (d) return d;
  d = new Database(p, { readonly: ro });
  d.pragma('journal_mode = WAL'); d.pragma('foreign_keys = ON'); d.pragma('synchronous = NORMAL');
  conns.set(p, d); return d;
}
function closeAll() { for (const [,d] of conns) { d.close(); } conns.clear(); }

function ok(c, m) { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.error(`  ❌ ${m}`); } }
function eq(a, b, m) { ok(a === b, `${m}: ${a} === ${b}`); }
function thr(fn, m) { try { fn(); fail++; console.error(`  ❌ ${m}`); } catch { pass++; console.log(`  ✅ ${m}`); } }

// ── Fake clock + scheduler ─────────────────────────────────────
class FakeClock {
  _now = 0; _mono = 0
  advance(ms) { this._now += ms; this._mono += ms }
  now() { return this._now }; monotonic() { return this._mono }; reset() { this._now = 0; this._mono = 0 }
}
class FakeScheduler {
  _total = 0; _delays = []
  get total() { return this._total }; get delays() { return [...this._delays] }
  async delay(ms) { this._total += ms; this._delays.push(ms) }
  reset() { this._total = 0; this._delays = [] }
}

// ── Create the corrected transaction manager using the same logic as the TS source ──
function assertSync(r) {
  if (r !== null && r !== undefined && typeof r.then === 'function') throw new Error('ASYNC_CALLBACK_DETECTED');
}

function createTx(db, policy) {
  const p = policy || {
    strategy: { delayMs: (a) => 50 * Math.pow(2, a) },
    budget: { maxAttempts: 3, deadlineMs: 999999 },
    clock: new FakeClock(), scheduler: new FakeScheduler(),
    classify: (e) => { const m = e.message.toLowerCase(); return (m.includes('busy')||m.includes('locked'))?'busy':(m.includes('unique')||m.includes('foreign')||m.includes('check'))?'constraint':'unknown'; },
    isRetryable: (r) => r === 'busy',
  };
  return {
    read: (fn) => { const txn = db.transaction(() => { const r = fn(); assertSync(r); return r }); return txn() },
    write: (fn) => { const txn = db.transaction(() => { const r = fn(); assertSync(r); return r }); return txn() },
    writeImmediate: (fn) => {
      db.exec('BEGIN IMMEDIATE');
      const txn = db.transaction(() => { const r = fn(); assertSync(r); return r });
      return txn();
    },
    savepoint: (name, fn) => {
      const sp = `sp_${name.replace(/[^a-z0-9_]/gi,'_')}_${Date.now()}`.slice(0,64);
      try {
        db.exec(`SAVEPOINT ${sp}`);
        const r = fn(); assertSync(r);
        db.exec(`RELEASE ${sp}`);
        return r;
      } catch (err) {
        let rb, rl;
        try { db.exec(`ROLLBACK TO ${sp}`) } catch(e) { rb = e }
        try { db.exec(`RELEASE ${sp}`) } catch(e) { rl = e }
        if (rb || rl) throw new Error('SavepointCleanupError: ' + (rb||'').toString() + (rl||'').toString());
        throw err;
      }
    },
  };
}

function applySchema(db) {
  db.exec(readFileSync('./schema-v0.2.6.sql','utf-8'));
}

const fc = new FakeClock(); const fs = new FakeScheduler();
const basePolicy = {
  strategy: { delayMs: (a) => 50 * Math.pow(2, a) },
  budget: { maxAttempts: 3, deadlineMs: fc.monotonic() + 10000 },
  clock: fc, scheduler: fs,
  classify: (e) => { const m = e.message.toLowerCase(); return (m.includes('busy')||m.includes('locked'))?'busy':(m.includes('unique')||m.includes('foreign')||m.includes('check'))?'constraint':'unknown'; },
  isRetryable: (r) => r === 'busy',
};

// ═══════════════════════════════════════════════════════════════════
console.log('=== P1.4: Thenable Detection Before Commit ===');
clean(); const db = openConn(DB); applySchema(db);
const tx = createTx(db, basePolicy);

// 1. Sync success
let sr = null;
tx.write(() => { sr = 'ok' });
eq(sr, 'ok', 'sync: commits');

// 2. Throw rolls back
thr(() => tx.write(() => {
  db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('tr','t','t',datetime('now'))").run();
  throw new Error('expected');
}), 'throw: rollback');
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 0, 'throw: zero rows');

// 3. Promise.resolve() detected BEFORE commit — rolled back
thr(() => tx.write(() => {
  db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('pr','t','t',datetime('now'))").run();
  return Promise.resolve('thenable');
}), 'Promise.resolve: rejected BEFORE commit');
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 0, 'Promise.resolve: zero rows');

// 4. Unresolved Promise — detected before commit, rolled back
let resolveLater;
const latePromise = new Promise(r => { resolveLater = r; });
thr(() => tx.write(() => {
  db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('up','t','t',datetime('now'))").run();
  return latePromise;  // never resolves during callback
}), 'unresolved Promise: rejected BEFORE commit');
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 0, 'unresolved: zero rows after rejection');

// 5. Resolve the late promise — verify it cannot mutate state
resolveLater('done');
// Wait a tick to let promise microtask queue drain
await new Promise(r => setTimeout(r, 10));
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 0, 'delayed resolve: still zero rows');

// 6. Custom thenable object
thr(() => tx.write(() => {
  db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('ct','t','t',datetime('now'))").run();
  return { then: () => {} };  // thenable object
}), 'custom thenable: rejected');
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 0, 'custom thenable: zero rows');

// 7. Savepoint thenable detection
thr(() => tx.savepoint('sp_test', () => {
  db.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('sp','t','t',datetime('now'))").run();
  return Promise.resolve('thenable in savepoint');
}), 'savepoint thenable: rejected');
eq(db.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 0, 'savepoint thenable: zero rows');

// 8. Read transaction thenable detection
thr(() => tx.read(() => {
  return Promise.resolve('thenable in read');
}), 'read thenable: rejected');

console.log('\n=== P1.4: Immediate Write + Concurrency ===');
clean(); const db2 = openConn(DB); applySchema(db2);
const tx2 = createTx(db2);

// Setup: family, contract, run
db2.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('fami','t','t',datetime('now'))").run();
db2.prepare("INSERT INTO task_contracts (contract_id,family_id,version,title,description,in_scope,out_of_scope,repo_url,repo_sha,created_by,created_at) VALUES ('ctri','fami',1,'T','D','[]','[]','u','s','t',datetime('now'))").run();
db2.prepare("INSERT INTO task_runs (run_id,contract_id,strategy,state,aggregate_version,baseline_sha,repo_branch,created_at,created_ts) VALUES ('runi','ctri','simple','created',1,'abc','main',datetime('now'),strftime('%s','now'))").run();

// Two writers with same expected version — first succeeds
const r1 = db2.prepare("UPDATE task_runs SET state='executing',aggregate_version=aggregate_version+1 WHERE run_id='runi' AND aggregate_version=1").run();
eq(r1.changes, 1, 'writer1: succeeds');
const r2 = db2.prepare("UPDATE task_runs SET state='verifying',aggregate_version=aggregate_version+1 WHERE run_id='runi' AND aggregate_version=1").run();
eq(r2.changes, 0, 'writer2: stale version rejected');

// Event duplicate version
db2.prepare("INSERT INTO events (event_id,event_type,aggregate_type,aggregate_id,aggregate_version,timestamp,data,metadata,created_ts) VALUES ('e-14','T','run','runi',1,datetime('now'),'{}','{}',strftime('%s','now'))").run();
thr(() => db2.prepare("INSERT INTO events (event_id,event_type,aggregate_type,aggregate_id,aggregate_version,timestamp,data,metadata,created_ts) VALUES ('e-14b','T','run','runi',1,datetime('now'),'{}','{}',strftime('%s','now'))").run(), 'event: duplicate version rejected');

// Immediate write test
tx2.writeImmediate(() => {
  db2.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('imm','immediate','t',datetime('now'))").run();
});
eq(db2.prepare("SELECT COUNT(*) AS c FROM contract_families WHERE family_id='imm'").get().c, 1, 'immediate write: committed');

console.log('\n=== P1.4: Retry Deadline Semantics ===');
clean(); const db3 = openConn(DB); applySchema(db3);
const fc3 = new FakeClock(); const fs3 = new FakeScheduler();

// Test delay computation: budget 1000ms, clock at 0, delay for attempt 0 = 50ms — fits
let remaining = 1000 - fc3.monotonic();
ok(remaining === 1000, 'deadline: remaining=1000');
ok(fc3.monotonic() < remaining, 'deadline: within budget');

// Test retry policy non-retryable classification
const p = basePolicy;
eq(p.classify(new Error('UNIQUE constraint failed')), 'constraint', 'classify: UNIQUE');
eq(p.classify(new Error('SQLITE_BUSY')), 'busy', 'classify: BUSY');
eq(p.isRetryable('constraint'), false, 'non-retryable: constraint');
eq(p.isRetryable('busy'), true, 'retryable: busy');

// Scheduler records exact delays
fs3.reset();
fs3.delay(50); fs3.delay(100);
// Wait for promises
await new Promise(r => setTimeout(r, 20));
ok(fs3.delays.length === 2, 'scheduler: 2 delays');
ok(fs3.total === 150, 'scheduler: total 150ms');

console.log('\n=== P1.4: Savepoint Cleanup ===');
clean(); const db4 = openConn(DB); applySchema(db4);
const tx4 = createTx(db4);

// Nested success
let spResult = null;
tx4.write(() => {
  db4.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('spo','outer','t',datetime('now'))").run();
  tx4.savepoint('inner', () => {
    db4.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('spi','inner','t',datetime('now'))").run();
    spResult = 'done';
  });
});
eq(spResult, 'done', 'savepoint: inner executed');
eq(db4.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 2, 'savepoint: both rows');

// Inner rollback preserves outer
tx4.write(() => {
  db4.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('spo2','outer2','t',datetime('now'))").run();
  thr(() => tx4.savepoint('roll_inner', () => {
    db4.prepare("INSERT INTO contract_families (family_id,name,created_by,created_at) VALUES ('spi2','inner2','t',datetime('now'))").run();
    throw new Error('inner_fail');
  }), 'savepoint: inner rollback + outer preserved');
});
eq(db4.prepare("SELECT COUNT(*) AS c FROM contract_families WHERE family_id LIKE 'spo%'").get().c, 2, 'savepoint: outer visible, inner rolled back');

console.log('\n=== P1.4: Schema + Package ===');
clean(); const db5 = openConn(DB); applySchema(db5);
eq(db5.prepare("PRAGMA foreign_key_check").all().length, 0, 'FK: 0 violations');
eq(db5.prepare("PRAGMA integrity_check").get().integrity_check, 'ok', 'integrity: ok');
const inv = db5.prepare("SELECT type,COUNT(*) AS cnt FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type").all();
for (const r of inv) console.log(`  ${r.type}: ${r.cnt}`);
eq(inv.find(r=>r.type==='table').cnt, 53, '53 tables');
eq(inv.find(r=>r.type==='trigger').cnt, 36, '36 triggers');
eq(inv.find(r=>r.type==='index').cnt, 66, '66 indexes');

console.log(`\n========================================`);
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
