import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  migrateRuntimeSchema,
  getSchemaVersion,
  initRuntimeSchema,
  RUNTIME_SCHEMA_VERSION,
  openSqliteStateStore,
} from "@/orchestration/runtime/index.js";

/**
 * The v1 runtime schema used `seq INTEGER GENERATED ALWAYS AS IDENTITY`
 * for transition_events, which is invalid SQLite syntax and could never
 * create the table. This is the broken DDL that migration must repair.
 */
const BROKEN_V1_EVENTS_DDL = `
  CREATE TABLE transition_events (
    run_id TEXT NOT NULL,
    seq INTEGER GENERATED ALWAYS AS IDENTITY,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    transition_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  )
`;

describe("Runtime Persistence — SQLite Migration", () => {
  it("migrates a v1 database to the current schema version (v2)", () => {
    const db = new Database(":memory:");

    // Build a v1 database: correct tables via initRuntimeSchema, then
    // replace transition_events with the broken v1 DDL.
    initRuntimeSchema(db);
    db.exec("DROP TABLE transition_events");
    try {
      db.exec(BROKEN_V1_EVENTS_DDL);
    } catch {
      // The broken v1 DDL fails to create in SQLite (invalid syntax) —
      // that is exactly the defect the migration must repair.
    }
    db.exec("PRAGMA user_version = 1");
    expect(getSchemaVersion(db)).toBe(1);

    // Upgrade
    migrateRuntimeSchema(db);

    // Schema version advanced
    expect(getSchemaVersion(db)).toBe(RUNTIME_SCHEMA_VERSION);
    expect(getSchemaVersion(db)).toBe(2);

    // transition_events exists with the corrected schema: seq is a plain
    // INTEGER, NOT NULL, part of the composite primary key.
    const cols = db
      .query("PRAGMA table_info(transition_events)")
      .all() as { name: string; type: string; notnull: number; pk: number }[];
    const seq = cols.find((c) => c.name === "seq");
    expect(seq).toBeDefined();
    expect(seq!.type).toBe("INTEGER");
    expect(seq!.notnull).toBe(1);
    expect(seq!.pk).toBe(2);

    // Inserting a transition event works against the migrated schema.
    db.exec(
      `INSERT INTO run_states (run_id, state, version, last_updated, metadata)
       VALUES ('migrated-run', 'created', 0, '2026-01-01T00:00:00.000Z', '{}')`,
    );
    db.query(
      `INSERT INTO transition_events
       (run_id, seq, from_state, to_state, transition_type, timestamp)
       VALUES (?, 0, ?, ?, ?, ?)`,
    ).run("migrated-run", "created", "planning", "normal", 1767225600000);

    const rows = db
      .query("SELECT * FROM transition_events WHERE run_id = ?")
      .all("migrated-run");
    expect(rows).toHaveLength(1);

    db.close();
  });

  it("upgrades an empty database directly to the current version", () => {
    const db = new Database(":memory:");
    expect(getSchemaVersion(db)).toBe(0);

    migrateRuntimeSchema(db);

    expect(getSchemaVersion(db)).toBe(RUNTIME_SCHEMA_VERSION);
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='transition_events'",
      )
      .all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("openSqliteStateStore throws when the database path cannot be opened", () => {
    // A directory path is not a valid SQLite database file.
    const dirPath = mkdtempSync(join(tmpdir(), "runtime-invalid-db-"));
    expect(() => openSqliteStateStore(dirPath)).toThrow();

    // An empty path is rejected explicitly.
    expect(() => openSqliteStateStore("")).toThrow();
  });
});