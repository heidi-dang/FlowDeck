import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner.ts";

const database = new Database(":memory:");
try {
  runMigrations(database);
  const schemaV = database.query("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
  const indexV = database.query("SELECT count(*) as cnt FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get();
  const triggerV = database.query("SELECT count(*) as cnt FROM sqlite_master WHERE type='trigger'").get();

  // Expected counts reflect the post-migration live DB state: initializeDatabase
  // runs migration v1 (frozen schema-v0.2.6.sql, 53 tables / 66 indexes / 36
  // triggers) PLUS migration v2 (replays table + 2 indexes) and v3 (durable
  // execution plans/workstreams/ownership/leases/integration tables) and the
  // durable M9 command_invocations table. The frozen-schema gate remains
  // separate and must not change.
  // The frozen-schema gate (scripts/check-schema-generated.mjs) still asserts
  // the v1 counts and must not change.
  console.log(`Schema Validation:`);
  console.log(`Tables: ${schemaV.cnt} (Expected: 62)`);
  console.log(`Indexes: ${indexV.cnt} (Expected: 84)`);
  console.log(`Triggers: ${triggerV.cnt} (Expected: 36)`);

  if (schemaV.cnt !== 62 || indexV.cnt !== 84 || triggerV.cnt !== 36) {
    console.error(`Schema invariants violated!`);
    process.exit(1);
  }

  const integrity = database.query("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== 'ok') {
    console.error(`Integrity check failed: ${integrity.integrity_check}`);
    process.exit(1);
  }

  const fks = database.query("PRAGMA foreign_key_check").all();
  if (fks.length > 0) {
    console.error(`Foreign key check failed:`, fks);
    process.exit(1);
  }

  console.log('Schema validation passed.');
} catch(e) {
  console.error(e);
  process.exit(1);
} finally {
  database.close();
}
