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

  console.log(`Schema Validation:`);
  console.log(`Tables: ${schemaV.cnt} (Expected: 53)`);
  console.log(`Indexes: ${indexV.cnt} (Expected: 66)`);
  console.log(`Triggers: ${triggerV.cnt} (Expected: 36)`);
  
  if (schemaV.cnt !== 53 || indexV.cnt !== 66 || triggerV.cnt !== 36) {
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
