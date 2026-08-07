import { readFileSync } from "fs";
import { createHash } from "crypto";;
const sql = readFileSync('schema-v0.2.6.sql', 'utf-8');
const checksum = createHash('sha256').update(sql, 'utf-8').digest('hex');
const embed = readFileSync('src/orchestration/persistence/migrations/schema-embed.ts', 'utf-8');
const m = embed.match(/Canonical checksum: ([a-f0-9]+)/);
const h = m ? m[1] : '';
const ok = checksum === h;
if (!ok) {
  console.error(`SCHEMA MISMATCH: canonical ${checksum}, embedded ${h}`);
  process.exit(1);
}
console.log(`Schema checksum OK (${checksum})`);
// Also check table/trigger/index counts
import { execSync } from 'child_process';

let tables, triggers, indexes, fk, integ;
try {
  execSync('rm -f /tmp/fd-schema-check.db');
  execSync('sqlite3 /tmp/fd-schema-check.db < schema-v0.2.6.sql');
  tables = execSync("sqlite3 /tmp/fd-schema-check.db 'SELECT COUNT(*) FROM sqlite_master WHERE type='\"'\"'table'\"'\"' AND name!='\"'\"'sqlite_sequence'\"'\"''").toString().trim();
  triggers = execSync("sqlite3 /tmp/fd-schema-check.db 'SELECT COUNT(*) FROM sqlite_master WHERE type='\"'\"'trigger'\"'\"''").toString().trim();
  indexes = execSync("sqlite3 /tmp/fd-schema-check.db 'SELECT COUNT(*) FROM sqlite_master WHERE type='\"'\"'index'\"'\"' AND name NOT LIKE '\"'\"'sqlite_%'\"'\"''").toString().trim();
  fk = execSync("sqlite3 /tmp/fd-schema-check.db 'PRAGMA foreign_key_check;' | wc -l").toString().trim();
  integ = execSync("sqlite3 /tmp/fd-schema-check.db 'PRAGMA integrity_check;'").toString().trim();
} catch {
  // sqlite3 CLI not available — fall back to bun:sqlite
  const res = execSync(
    `bun -e 'import { Database } from "bun:sqlite"; const db = new Database(":memory:"); db.run(require("fs").readFileSync("schema-v0.2.6.sql", "utf-8")); const t = db.query("SELECT COUNT(*) AS c FROM sqlite_master WHERE type=\\"table\\" AND name!=\\"sqlite_sequence\\"").get().c; const tg = db.query("SELECT COUNT(*) AS c FROM sqlite_master WHERE type=\\"trigger\\"").get().c; const idx = db.query("SELECT COUNT(*) AS c FROM sqlite_master WHERE type=\\"index\\" AND name NOT LIKE \\"sqlite_%\\"").get().c; const fkVal = db.query("PRAGMA foreign_key_check;").all().length; const integVal = db.query("PRAGMA integrity_check;").get()["integrity_check"]; console.log(JSON.stringify({ t, tg, idx, fk: fkVal, integ: integVal }))'`
  ).toString().trim();
  const parsed = JSON.parse(res);
  tables = String(parsed.t);
  triggers = String(parsed.tg);
  indexes = String(parsed.idx);
  fk = String(parsed.fk);
  integ = String(parsed.integ);
}

console.log(`Tables: ${tables}, Triggers: ${triggers}, Indexes: ${indexes}, FK violations: ${fk}, Integrity: ${integ}`);
if (tables !== '53') { console.error(`Expected 53 tables, got ${tables}`); process.exit(1); }
if (triggers !== '36') { console.error(`Expected 36 triggers, got ${triggers}`); process.exit(1); }
if (indexes !== '66') { console.error(`Expected 66 indexes, got ${indexes}`); process.exit(1); }
if (fk !== '0') { console.error(`FK violations: ${fk}`); process.exit(1); }
if (integ !== 'ok') { console.error(`Integrity: ${integ}`); process.exit(1); }
console.log('Schema validation: ALL PASS');
