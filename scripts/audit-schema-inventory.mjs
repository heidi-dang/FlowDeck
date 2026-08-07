// Independent audit of schema-v0.2.6.sql against architecture-freeze-v0.2.6.json
// Executes the schema in a fresh SQLite DB, then compares sqlite_master
// inventories (tables/triggers/indexes) with the pinned manifest.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const ROOT = process.cwd();
const SCHEMA_FILE = `${ROOT}/schema-v0.2.6.sql`;
const MANIFEST_FILE = `${ROOT}/architecture-freeze-v0.2.6.json`;
const DB_PATH = `/tmp/opencode/audit-schema-v026-${Date.now()}.db`;

const schemaSql = readFileSync(SCHEMA_FILE, "utf8");
const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));

const db = new Database(DB_PATH);

// 1. Execute full schema
try {
  db.exec(schemaSql);
  console.log("SCHEMA EXEC: OK");
} catch (e) {
  console.error("SCHEMA EXEC: FAILED:", e.message);
  process.exit(1);
}

// 2. Integrity check
const integrity = db.query("PRAGMA integrity_check").get();
console.log("INTEGRITY:", JSON.stringify(integrity));

// 3. FK check
const fkViolations = db.query("PRAGMA foreign_key_check").all();
console.log("FK_VIOLATIONS:", fkViolations.length);

// 4. Inventory from sqlite_master
const tables = db.query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((r) => r.name);
const triggers = db.query(
  "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
).all().map((r) => r.name);
const indexes = db.query(
  "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((r) => r.name);

console.log(`ACTUAL: tables=${tables.length} triggers=${triggers.length} indexes=${indexes.length}`);
console.log(`PINNED: tables=${manifest.tables} triggers=${manifest.triggers} indexes=${manifest.indexes}`);

// 5. Compare inventories
let errors = 0;
const diffTable = (label, actual, pinned) => {
  const a = new Set(actual);
  const p = new Set(pinned);
  const missing = [...p].filter((x) => !a.has(x));
  const extra = [...a].filter((x) => !p.has(x));
  if (missing.length || extra.length) {
    errors++;
    console.log(`MISMATCH ${label}:`);
    if (missing.length) console.log(`  pinned-but-missing: ${missing.join(", ")}`);
    if (extra.length) console.log(`  actual-but-not-pinned: ${extra.join(", ")}`);
  } else {
    console.log(`MATCH ${label}: ${actual.length}`);
  }
};

diffTable("tables", tables, manifest.objects.tables);
diffTable("triggers", triggers, manifest.objects.triggers);
diffTable("indexes", indexes, manifest.objects.indexes);

// 6. FK references — report count
const fkCheck = db.query("PRAGMA foreign_key_list").all();
console.log("FOREIGN_KEY_LIST_ROWS:", fkCheck.length);

// 7. Row-level checks: fresh schema should be empty except sequences
const nonEmpty = tables
  .map((t) => ({ t, n: db.query(`SELECT COUNT(*) AS n FROM "${t}"`).get().n }))
  .filter((r) => r.n > 0);
console.log("NON_EMPTY_TABLES:", nonEmpty.length === 0 ? "none" : JSON.stringify(nonEmpty));

db.close();

if (errors > 0) {
  console.error(`AUDIT: FAILED with ${errors} mismatch(es)`);
  process.exit(1);
}
console.log("AUDIT: PASS");
