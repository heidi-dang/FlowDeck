import { Database } from "bun:sqlite";
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner.ts";

const database = new Database(":memory:");
try {
  runMigrations(database);
  const schemaV = database.query("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
  const indexV = database.query("SELECT count(*) as cnt FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get();
  const triggerV = database.query("SELECT count(*) as cnt FROM sqlite_master WHERE type='trigger'").get();

  // Expected counts reflect the ACTUAL post-migration live DB state, aligned
  // with the migration registry as merged on the release line:
  //   v1 frozen schema-v0.2.6.sql (53 tables / 66 indexes / 36 triggers)
  //   + v2 replay table + 2 indexes
  //   + v3 durable execution plans/workstreams/ownership/leases/integration
  //   + v4 agent performance + v5 execution integrity + v6 command_invocations
  //   + v7 assignment_execution_bindings (1 table + 3 indexes)
  // + v8 Heidi memory/archive/audit + v9 learning/skills/scheduler
  // + v10 completion-review and delegation projections
  // = 82 tables / 91 indexes / 38 triggers (the FTS virtual table is excluded by the count query).
  // The frozen-schema gate (scripts/check-schema-generated.mjs) still asserts
  // ONLY the v1 counts and must not change.
  console.log(`Schema Validation:`);
  console.log(`Tables: ${schemaV.cnt} (Expected: 82)`);
  console.log(`Indexes: ${indexV.cnt} (Expected: 91)`);
  console.log(`Triggers: ${triggerV.cnt} (Expected: 38)`);

  if (schemaV.cnt !== 82 || indexV.cnt !== 91 || triggerV.cnt !== 38) {
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
