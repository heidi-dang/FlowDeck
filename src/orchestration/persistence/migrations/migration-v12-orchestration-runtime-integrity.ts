export const MIGRATION_V12_ORCHESTRATION_RUNTIME_INTEGRITY_SQL = `
CREATE TABLE IF NOT EXISTS session_turns (
  session_id TEXT PRIMARY KEY,
  user_turn_version INTEGER NOT NULL DEFAULT 1,
  last_user_message_id TEXT,
  last_user_message_hash TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS continuation_dispatches (
  identity TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_turn_version INTEGER NOT NULL,
  run_aggregate_version INTEGER NOT NULL,
  transition_reason TEXT NOT NULL,
  current_work_item_id TEXT,
  state_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'dispatched', 'failed', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  dispatched_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_run ON continuation_dispatches(run_id, session_id);
CREATE INDEX IF NOT EXISTS idx_continuation_dispatches_status ON continuation_dispatches(status);

CREATE TABLE IF NOT EXISTS call_id_attempts (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_id_attempts_run_as ON call_id_attempts(run_id, assignment_id, attempt_number);
`;
