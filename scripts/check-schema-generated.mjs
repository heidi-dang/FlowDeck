import { readFileSync } from "fs";
import { createHash } from "crypto";
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SQL_FILE = 'schema-v0.2.6.sql';
const EMBED_FILE = 'src/orchestration/persistence/migrations/schema-embed.ts';
const TMP_DB = '/tmp/fd-schema-check.db';

const sql = readFileSync(SQL_FILE, 'utf-8');
const checksum = createHash('sha256').update(sql, 'utf-8').digest('hex');
const embed = readFileSync(EMBED_FILE, 'utf-8');
const m = embed.match(/Canonical checksum: ([a-f0-9]+)/);
const h = m ? m[1] : '';
const ok = checksum === h;
if (!ok) {
  console.error(`SCHEMA MISMATCH: canonical ${checksum}, embedded ${h}`);
  process.exit(1);
}
console.log(`Schema checksum OK (${checksum})`);

// ── Helpers for running SQLite validation ───────────────────────────────

/**
 * Attempt to locate the sqlite3 CLI binary.
 * Returns the path if found, or null if not available.
 */
function findSqlite3Cli() {
  try {
    const path = execSync('command -v sqlite3', { stdio: 'pipe' }).toString().trim();
    if (path) return path;
  } catch {
    // sqlite3 not on PATH
  }
  return null;
}

/**
 * Check whether the bun binary is available.
 */
function findBun() {
  try {
    const path = execSync('command -v bun', { stdio: 'pipe' }).toString().trim();
    if (path) return path;
  } catch {
    // bun not on PATH
  }
  return null;
}

/**
 * Validate schema using the sqlite3 CLI.
 * Throws on any schema error or CLI failure — does NOT fall back silently.
 */
function validateWithCli() {
  execSync(`rm -f ${TMP_DB}`);
  execSync(`sqlite3 ${TMP_DB} < ${SQL_FILE}`);
  const tables = execSync(
    `sqlite3 ${TMP_DB} 'SELECT COUNT(*) FROM sqlite_master WHERE type="table" AND name!="sqlite_sequence"'`
  ).toString().trim();
  const triggers = execSync(
    `sqlite3 ${TMP_DB} 'SELECT COUNT(*) FROM sqlite_master WHERE type="trigger"'`
  ).toString().trim();
  const indexes = execSync(
    `sqlite3 ${TMP_DB} 'SELECT COUNT(*) FROM sqlite_master WHERE type="index" AND name NOT LIKE "sqlite_%"'`
  ).toString().trim();
  const fk = execSync(
    `sqlite3 ${TMP_DB} 'PRAGMA foreign_key_check;' | wc -l`
  ).toString().trim();
  const integ = execSync(
    `sqlite3 ${TMP_DB} 'PRAGMA integrity_check;'`
  ).toString().trim();
  return { tables, triggers, indexes, fk, integ };
}

/**
 * Validate schema using Bun's built-in sqlite3 module.
 * Throws on any schema error — fail closed.
 */
function validateWithBun() {
  const bunPath = findBun();
  if (bunPath === null) {
    throw new Error('Neither sqlite3 CLI nor bun is available for schema validation');
  }

  // Write a temporary validator script to avoid shell escaping issues
  const tmpScript = join(tmpdir(), `schema-check-${Date.now()}.bun.js`);
  const script = [
    'import { Database } from "bun:sqlite";',
    'import { readFileSync } from "fs";',
    'const sql = readFileSync("' + SQL_FILE + '", "utf-8");',
    'const db = new Database(":memory:");',
    'db.run(sql);',
    'const t = db.query(\'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="table" AND name!="sqlite_sequence"\').get().c;',
    'const tg = db.query(\'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="trigger"\').get().c;',
    'const idx = db.query(\'SELECT COUNT(*) AS c FROM sqlite_master WHERE type="index" AND name NOT LIKE "sqlite_%"\').get().c;',
    'const fkVal = db.query("PRAGMA foreign_key_check;").all().length;',
    'const integVal = db.query("PRAGMA integrity_check;").get()["integrity_check"];',
    'console.log(JSON.stringify({ t, tg, idx, fk: fkVal, integ: integVal }));',
    'db.close();',
  ].join('\n');

  try {
    writeFileSync(tmpScript, script);
    const res = execSync(`${bunPath} ${tmpScript}`, { stdio: 'pipe' }).toString().trim();
    const parsed = JSON.parse(res);
    return {
      tables: String(parsed.t),
      triggers: String(parsed.tg),
      indexes: String(parsed.idx),
      fk: String(parsed.fk),
      integ: String(parsed.integ),
    };
  } finally {
    try { unlinkSync(tmpScript); } catch { /* ignore */ }
  }
}

// ── Main validation logic ─────────────────────────────────────────────────

// Determine which validation path to use.
// Only fall back to Bun when the sqlite3 CLI is genuinely unavailable.
// If sqlite3 is available but schema validation fails, that is a real failure.
let stats;
let usedPath;

const sqlite3Path = findSqlite3Cli();
if (sqlite3Path !== null) {
  usedPath = "cli";
  stats = validateWithCli();
} else {
  // sqlite3 CLI not available — safely fall back to bun:sqlite
  usedPath = "bun";
  stats = validateWithBun();
}

console.log(`Validation path: ${usedPath === "cli" ? "sqlite3 CLI" : "bun:sqlite fallback"}`);
console.log(`Tables: ${stats.tables}, Triggers: ${stats.triggers}, Indexes: ${stats.indexes}, FK violations: ${stats.fk}, Integrity: ${stats.integ}`);

if (stats.tables !== '53') { console.error(`Expected 53 tables, got ${stats.tables}`); process.exit(1); }
if (stats.triggers !== '36') { console.error(`Expected 36 triggers, got ${stats.triggers}`); process.exit(1); }
if (stats.indexes !== '66') { console.error(`Expected 66 indexes, got ${stats.indexes}`); process.exit(1); }
if (stats.fk !== '0') { console.error(`FK violations: ${stats.fk}`); process.exit(1); }
if (stats.integ !== 'ok') { console.error(`Integrity: ${stats.integ}`); process.exit(1); }
console.log('Schema validation: ALL PASS');