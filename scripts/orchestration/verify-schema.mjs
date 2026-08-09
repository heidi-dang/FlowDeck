import { initializeDatabase, closeConnection } from '../../src/orchestration/persistence/database.js';
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "flowdeck-schema-"));
const databasePath = join(directory, "schema.db");

let database;

try {
  const initialized = initializeDatabase({
    path: databasePath,
    readonly: false,
  });

  database = initialized.db;

  const schemaV = database.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
  const indexV = database.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get();
  const triggerV = database.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='trigger'").get();

  // Expected counts reflect the post-migration live DB state: initializeDatabase
  // runs migration v1 (frozen schema-v0.2.6.sql, 53 tables / 66 indexes / 36
  // triggers) PLUS migration v2 (replays table + 2 indexes) — the sanctioned
  // additive path per E.3.1 of the master-plan task brief, implemented in
  // src/orchestration/persistence/migrations/migration-v2-replay.ts.
  // The frozen-schema gate (scripts/check-schema-generated.mjs) still asserts
  // the v1 counts and must not change.
  console.log(`Schema Validation:`);
  console.log(`Tables: ${schemaV.cnt} (Expected: 54)`);
  console.log(`Indexes: ${indexV.cnt} (Expected: 68)`);
  console.log(`Triggers: ${triggerV.cnt} (Expected: 36)`);

  if (schemaV.cnt !== 54 || indexV.cnt !== 68 || triggerV.cnt !== 36) {
    console.error(`Schema invariants violated!`);
    process.exit(1);
  }

  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== 'ok') {
    console.error(`Integrity check failed: ${integrity.integrity_check}`);
    process.exit(1);
  }

  const fks = database.prepare("PRAGMA foreign_key_check").all();
  if (fks.length > 0) {
    console.error(`Foreign key check failed:`, fks);
    process.exit(1);
  }

  console.log('Schema validation passed.');
} catch(e) {
  console.error(e);
  process.exit(1);
} finally {
  closeConnection(databasePath);
  try { rmSync(directory, { recursive: true, force: true }); } catch {}
}
