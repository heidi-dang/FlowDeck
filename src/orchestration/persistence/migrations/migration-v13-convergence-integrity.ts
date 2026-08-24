import type { Database } from "bun:sqlite"

export const MIGRATION_V13_CONVERGENCE_INTEGRITY_SQL = `
CREATE TABLE IF NOT EXISTS session_turn_messages (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_hash TEXT,
  user_turn_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_session_turn_messages_sess ON session_turn_messages(session_id);

CREATE TABLE IF NOT EXISTS deferred_replacements (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  old_run_id TEXT NOT NULL,
  source_intent TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  effective_goal TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  message_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  routing_decision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_termination', 'resuming', 'resumed', 'superseded', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resumed_at TEXT,
  replacement_run_id TEXT,
  superseded_by_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_deferred_replacements_session ON deferred_replacements(parent_session_id, status);

CREATE TABLE IF NOT EXISTS continuation_dispatches_v13_target (
  identity TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_turn_version INTEGER NOT NULL,
  run_aggregate_version INTEGER NOT NULL,
  transition_reason TEXT NOT NULL,
  current_work_item_id TEXT,
  state_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'dispatched', 'failed', 'blocked', 'outcome_unknown')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  dispatched_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_run ON continuation_dispatches(run_id, session_id);
CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_status ON continuation_dispatches(status);
CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_state_status ON continuation_dispatches(run_id, state_fingerprint, status);
`;

export function applyV13Migration(db: Database): void {
  // 1. Create session_turn_messages and deferred_replacements
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_turn_messages (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_hash TEXT,
      user_turn_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_turn_messages_sess ON session_turn_messages(session_id);

    CREATE TABLE IF NOT EXISTS deferred_replacements (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      old_run_id TEXT NOT NULL,
      source_intent TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      effective_goal TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      message_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      routing_decision TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_termination', 'resuming', 'resumed', 'superseded', 'blocked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resumed_at TEXT,
      replacement_run_id TEXT,
      superseded_by_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deferred_replacements_session ON deferred_replacements(parent_session_id, status);
  `);

  // 2. Inspect continuation_dispatches schema
  const tableInfo = db.query("PRAGMA table_info(continuation_dispatches)").all() as { name: string }[];
  if (tableInfo.length > 0) {
    const colNames = new Set(tableInfo.map(c => c.name));
    const hasAttemptCount = colNames.has("attempt_count");
    const hasLastAttemptAt = colNames.has("last_attempt_at");

    db.exec(`
      CREATE TABLE continuation_dispatches_v13 (
        identity TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_turn_version INTEGER NOT NULL,
        run_aggregate_version INTEGER NOT NULL,
        transition_reason TEXT NOT NULL,
        current_work_item_id TEXT,
        state_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'dispatched', 'failed', 'blocked', 'outcome_unknown')),
        attempt_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL,
        dispatched_at TEXT,
        error TEXT
      );
    `);

    const attemptColExpr = hasAttemptCount ? "COALESCE(attempt_count, 1)" : "1";
    const lastAttemptColExpr = hasLastAttemptAt ? "COALESCE(last_attempt_at, created_at)" : "created_at";

    db.exec(`
      INSERT OR IGNORE INTO continuation_dispatches_v13 (
        identity, run_id, session_id, user_turn_version, run_aggregate_version,
        transition_reason, current_work_item_id, state_fingerprint, status,
        attempt_count, created_at, last_attempt_at, dispatched_at, error
      )
      SELECT
        identity, run_id, session_id, user_turn_version, run_aggregate_version,
        transition_reason, current_work_item_id, state_fingerprint,
        CASE WHEN status IN ('pending', 'dispatched', 'failed', 'blocked', 'outcome_unknown') THEN status ELSE 'failed' END,
        ${attemptColExpr},
        created_at,
        ${lastAttemptColExpr},
        dispatched_at,
        error
      FROM continuation_dispatches;

      DROP TABLE continuation_dispatches;
      ALTER TABLE continuation_dispatches_v13 RENAME TO continuation_dispatches;

      CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_run ON continuation_dispatches(run_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_status ON continuation_dispatches(status);
      CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_state_status ON continuation_dispatches(run_id, state_fingerprint, status);
    `);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS continuation_dispatches (
        identity TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_turn_version INTEGER NOT NULL,
        run_aggregate_version INTEGER NOT NULL,
        transition_reason TEXT NOT NULL,
        current_work_item_id TEXT,
        state_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'dispatched', 'failed', 'blocked', 'outcome_unknown')),
        attempt_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_attempt_at TEXT NOT NULL,
        dispatched_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_run ON continuation_dispatches(run_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_status ON continuation_dispatches(status);
      CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_state_status ON continuation_dispatches(run_id, state_fingerprint, status);
    `);
  }
}
