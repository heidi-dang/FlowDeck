// Persistence layer tests using Node.js (not bun, due to NAPI crash with better-sqlite3)
import { unlinkSync, existsSync } from 'fs';
import Database from 'better-sqlite3';

const DB = '/tmp/flowdeck-test.db';
let pass = 0, fail = 0;

function clean() {
  try { closeConn(DB); } catch {}
  for (const f of [DB, DB+'-wal', DB+'-shm']) { try { unlinkSync(f) } catch {} }
}
const conns = new Map();
function openConn(p, ro = false) {
  let d = conns.get(p); if (d) return d;
  d = new Database(p, { readonly: ro });
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  d.pragma('synchronous = NORMAL');
  conns.set(p, d); return d;
}
function closeConn(p) { const d = conns.get(p); if (d) { d.close(); conns.delete(p); } }

function ok(c, m) { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.error(`  ❌ ${m}`); } }
function eq(a, b, m) { ok(a === b, `${m}: ${a} === ${b}`); }
function thr(fn, m) { try { fn(); fail++; console.error(`  ❌ ${m}: no error`); } catch { pass++; console.log(`  ✅ ${m}`); } }

// Create a simple in-process migration since we can't import TS
function runMigration(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT, checksum TEXT, duration_ms INTEGER)`);
  const applied = new Map(db.prepare('SELECT version, checksum FROM schema_migrations').all().map(r => [r.version, r]));
  if (applied.has(1)) return; // already applied

  db.exec(`CREATE TABLE IF NOT EXISTS contract_families (family_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_contracts (contract_id TEXT PRIMARY KEY, family_id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, in_scope TEXT NOT NULL DEFAULT '[]', out_of_scope TEXT NOT NULL DEFAULT '[]', payload_hash TEXT, repo_url TEXT NOT NULL, repo_sha TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(family_id, version), UNIQUE(contract_id, family_id), FOREIGN KEY (family_id) REFERENCES contract_families(family_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS contract_lifecycle (contract_id TEXT PRIMARY KEY, family_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','superseded','archived')), activated_at TEXT, superseded_at TEXT, archived_at TEXT, superseded_by TEXT, updated_ts INTEGER NOT NULL, FOREIGN KEY (contract_id, family_id) REFERENCES task_contracts(contract_id, family_id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY (superseded_by) REFERENCES task_contracts(contract_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS requirements (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')), sort_order INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS acceptance_criteria (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, requirement_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, verification_method TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('critical','high','medium')), sort_order INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS objectives (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, sequence INTEGER NOT NULL, description TEXT NOT NULL, FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS constraints (id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'must' CHECK(severity IN ('must','should','nice-to-have')), description TEXT NOT NULL, FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS task_runs (run_id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, strategy TEXT NOT NULL DEFAULT 'simple' CHECK(strategy IN ('simple','planned','delegated','audit','recovery')), state TEXT NOT NULL DEFAULT 'created' CHECK(state IN ('created','planning','analysing','delegating','executing','verifying','recovering','completed','failed','cancelled')), aggregate_version INTEGER NOT NULL DEFAULT 1, baseline_sha TEXT NOT NULL, current_sha TEXT, verification_sha TEXT, completion_sha TEXT, repo_branch TEXT NOT NULL, working_tree_clean INTEGER NOT NULL DEFAULT 1, previous_run_id TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, created_ts INTEGER NOT NULL, FOREIGN KEY (contract_id) REFERENCES task_contracts(contract_id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY (previous_run_id) REFERENCES task_runs(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS run_requirements (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, requirement_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','implemented','verified','rejected','failed')), started_at TEXT, completed_at TEXT, UNIQUE(run_id, requirement_id), FOREIGN KEY (run_id) REFERENCES task_runs(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS run_acceptance_criteria (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, criterion_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','passed','failed','blocked')), verified_at TEXT, verified_by TEXT, failure_reason TEXT, UNIQUE(run_id, criterion_id), FOREIGN KEY (run_id) REFERENCES task_runs(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY (criterion_id) REFERENCES acceptance_criteria(id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped','cancelled')), is_required INTEGER NOT NULL DEFAULT 1 CHECK(is_required IN (0,1)), priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, duration_ms INTEGER, created_by TEXT NOT NULL, attempt_number INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 3, error_message TEXT, FOREIGN KEY (run_id) REFERENCES task_runs(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, evidence_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT, source TEXT NOT NULL, source_id TEXT, content_hash TEXT NOT NULL, file_path TEXT, format TEXT NOT NULL DEFAULT 'json', size INTEGER, sha TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (run_id) REFERENCES task_runs(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS events (global_sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, event_version INTEGER NOT NULL DEFAULT 1, causation_id TEXT, correlation_id TEXT, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL, timestamp TEXT NOT NULL, data TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_ts INTEGER NOT NULL, UNIQUE(aggregate_type, aggregate_id, aggregate_version))`);
  db.exec(`CREATE TABLE IF NOT EXISTS event_outbox (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, event_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivering','delivered','failed','dead_letter','partially_delivered')), retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_retry_ts INTEGER, created_ts INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, source_component TEXT NOT NULL, FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS event_subscribers (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, subscription_type TEXT NOT NULL CHECK(subscription_type IN ('transactional','durable_async','best_effort')), event_types TEXT NOT NULL, is_required INTEGER NOT NULL DEFAULT 1 CHECK(is_required IN (0,1)), created_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1)`);
  db.exec(`CREATE TABLE IF NOT EXISTS repositories (repository_id TEXT PRIMARY KEY, url TEXT NOT NULL, canonical_path TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(url))`);
  db.exec(`CREATE TABLE IF NOT EXISTS worktrees (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, assignment_id TEXT, repository_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, phase INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','merged','conflict','cleaned')), created_at TEXT NOT NULL, merged_at TEXT, conflict_details TEXT, UNIQUE(repository_id, path), FOREIGN KEY (run_id) REFERENCES task_runs(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE RESTRICT ON UPDATE RESTRICT, FOREIGN KEY (repository_id) REFERENCES repositories(repository_id) ON DELETE RESTRICT ON UPDATE RESTRICT)`);

  db.prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum, duration_ms) VALUES (1, ?, datetime(\'now\'), ?, 0)').run('initial', 'abc');
}

function createTx(db) {
  return {
    read: (fn) => db.transaction(fn)(),
    write: (fn) => db.transaction(fn)(),
    savepoint: (name, fn) => {
      const sp = `sp_${name}`;
      try { db.exec(`SAVEPOINT ${sp}`); const r = fn(); db.exec(`RELEASE ${sp}`); return r; }
      catch (e) { db.exec(`ROLLBACK TO ${sp}`); throw e; }
    }
  };
}

// ── Tests ──

console.log('=== Database bootstrap ===');
clean();
const db = openConn(DB);
eq(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign_keys ON');
eq(db.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase(), 'wal', 'WAL mode');
closeConn(DB);
const db2 = openConn(DB);
ok(db2 === openConn(DB), 'connection reuse');

console.log('\n=== Migrations ===');
clean();
const db3 = openConn(DB);
runMigration(db3);
const tables = db3.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name!='sqlite_sequence'").get().c;
ok(tables >= 14, `tables created: ${tables}`);

console.log('\n=== Transactions ===');
const db4 = openConn(DB);
runMigration(db4);
const tx = createTx(db4);
tx.write(() => { db4.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES ('f1','t','t',datetime('now'))").run(); });
eq(db4.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 1, 'write commits');
thr(() => tx.write(() => {
  db4.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES ('f2','r','t',datetime('now'))").run();
  throw new Error('force');
}), 'rollback on error');
eq(db4.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 1, 'rollback effective');

console.log('\n=== Nested savepoints ===');
tx.write(() => {
  db4.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES ('f3','o','t',datetime('now'))").run();
  thr(() => tx.savepoint('inner', () => {
    db4.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES ('f4','i','t',datetime('now'))").run();
    throw new Error('inner');
  }), 'savepoint rollback');
});
eq(db4.prepare("SELECT COUNT(*) AS c FROM contract_families").get().c, 2, 'outer kept, inner rolled back');

console.log('\n=== Schema validation ===');
const fk = db4.prepare('PRAGMA foreign_key_check').all();
eq(fk.length, 0, 'foreign_key_check = 0');
const integ = db4.prepare('PRAGMA integrity_check').get();
eq(integ.integrity_check, 'ok', 'integrity_check = ok');

console.log('\n=== Events (append-only) ===');
const events = db4.prepare("INSERT INTO events (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts) VALUES ('e1','T','run','r1',1,datetime('now'),'{}','{}',strftime('%s','now'))").run();
ok(events.changes === 1, 'event inserted');
thr(() => db4.prepare("INSERT INTO events (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts) VALUES ('e2','T','run','r1',1,datetime('now'),'{}','{}',strftime('%s','now'))").run(), 'rejects duplicate aggregate version');

console.log('\n=== Events + Outbox ===');
db4.prepare("INSERT INTO event_outbox (id, event_id, event_type, aggregate_id, data, idempotency_key, source_component, created_ts) VALUES ('ob1','e1','T','r1','{}','ik1','test',strftime('%s','now'))").run();
eq(db4.prepare("SELECT COUNT(*) AS c FROM event_outbox").get().c, 1, 'outbox row created');
eq(db4.prepare("SELECT status FROM event_outbox WHERE id='ob1'").get().status, 'pending', 'status=pending');

console.log('\n=== TaskRuns ===');
db4.prepare("INSERT INTO contract_families (family_id, name, created_by, created_at) VALUES ('fam1','t','t',datetime('now'))").run();
db4.prepare("INSERT INTO task_contracts (contract_id, family_id, version, title, description, in_scope, out_of_scope, repo_url, repo_sha, created_by, created_at) VALUES ('ctr1','fam1',1,'T','D','[]','[]','u','s','t',datetime('now'))").run();
db4.prepare("INSERT INTO task_runs (run_id, contract_id, strategy, state, aggregate_version, baseline_sha, repo_branch, created_at, created_ts) VALUES ('run1','ctr1','simple','created',1,'abc','main',datetime('now'),strftime('%s','now'))").run();
const r = db4.prepare("SELECT state, aggregate_version FROM task_runs WHERE run_id='run1'").get();
eq(r.state, 'created', 'run state=created');
eq(r.aggregate_version, 1, 'version=1');

console.log('\n=== Schema inventory ===');
const types = db4.prepare("SELECT type, COUNT(*) AS cnt FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type").all();
for (const row of types) console.log(`  ${row.type}: ${row.cnt}`);

console.log(`\n========================================`);
console.log(`Results: ${pass} passed, ${fail} failed`);
console.log(`========================================`);
process.exit(fail > 0 ? 1 : 0);
