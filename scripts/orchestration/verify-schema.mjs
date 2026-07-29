import { initializeDatabase } from '../../src/orchestration/persistence/database.js';

import { unlinkSync, existsSync } from 'fs';

const dbPath = 'schema_verify.db';
if (existsSync(dbPath)) unlinkSync(dbPath);

try {
  const { db, diagnostics } = initializeDatabase({ path: dbPath, readonly: false });
  const schemaV = db.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
  const indexV = db.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get();
  const triggerV = db.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='trigger'").get();

  console.log(`Schema Validation:`);
  console.log(`Tables: ${schemaV.cnt} (Expected: 53)`);
  console.log(`Indexes: ${indexV.cnt} (Expected: 66)`);
  console.log(`Triggers: ${triggerV.cnt} (Expected: 36)`);
  
  if (schemaV.cnt !== 53 || indexV.cnt !== 66 || triggerV.cnt !== 36) {
    console.error(`Schema invariants violated!`);
    process.exit(1);
  }
  console.log('Schema validation passed.');
} catch(e) {
  console.error(e);
  process.exit(1);
} finally {
  if (existsSync(dbPath)) unlinkSync(dbPath);
}
