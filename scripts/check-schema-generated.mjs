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
execSync('rm -f /tmp/fd-schema-check.db');
execSync('sqlite3 /tmp/fd-schema-check.db < schema-v0.2.6.sql');
const tables = execSync("sqlite3 /tmp/fd-schema-check.db 'SELECT COUNT(*) FROM sqlite_master WHERE type='\"'\"'table'\"'\"' AND name!='\"'\"'sqlite_sequence'\"'\"''").toString().trim();
const triggers = execSync("sqlite3 /tmp/fd-schema-check.db 'SELECT COUNT(*) FROM sqlite_master WHERE type='\"'\"'trigger'\"'\"''").toString().trim();
const indexes = execSync("sqlite3 /tmp/fd-schema-check.db 'SELECT COUNT(*) FROM sqlite_master WHERE type='\"'\"'index'\"'\"' AND name NOT LIKE '\"'\"'sqlite_%'\"'\"''").toString().trim();
const fk = execSync("sqlite3 /tmp/fd-schema-check.db 'PRAGMA foreign_key_check;' | wc -l").toString().trim();
const integ = execSync("sqlite3 /tmp/fd-schema-check.db 'PRAGMA integrity_check;'").toString().trim();
console.log(`Tables: ${tables}, Triggers: ${triggers}, Indexes: ${indexes}, FK violations: ${fk}, Integrity: ${integ}`);
if (tables !== '53') { console.error(`Expected 53 tables, got ${tables}`); process.exit(1); }
if (triggers !== '36') { console.error(`Expected 36 triggers, got ${triggers}`); process.exit(1); }
if (indexes !== '66') { console.error(`Expected 66 indexes, got ${indexes}`); process.exit(1); }
if (fk !== '0') { console.error(`FK violations: ${fk}`); process.exit(1); }
if (integ !== 'ok') { console.error(`Integrity: ${integ}`); process.exit(1); }
console.log('Schema validation: ALL PASS');
