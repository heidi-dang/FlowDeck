export const MIGRATION_V12_ORCHESTRATION_RUNTIME_INTEGRITY_SQL = `
CREATE TABLE IF NOT EXISTS session_turns (
  session_id TEXT PRIMARY KEY,
  user_turn_version INTEGER NOT NULL DEFAULT 1,
  last_user_message_id TEXT,
  last_user_message_hash TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_turn_messages (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_hash TEXT,
  user_turn_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_session_turn_messages_sess ON session_turn_messages(session_id);

CREATE TABLE IF NOT EXISTS continuation_dispatches (
  identity TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_turn_version INTEGER NOT NULL,
  run_aggregate_version INTEGER NOT NULL,
  transition_reason TEXT NOT NULL,
  current_work_item_id TEXT,
  state_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS continuation_dispatches_v12 (
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

INSERT OR IGNORE INTO continuation_dispatches_v12 (
  identity, run_id, session_id, user_turn_version, run_aggregate_version,
  transition_reason, current_work_item_id, state_fingerprint, status,
  attempt_count, created_at, last_attempt_at, dispatched_at, error
)
SELECT
  identity, run_id, session_id, user_turn_version, run_aggregate_version,
  transition_reason, current_work_item_id, state_fingerprint,
  CASE WHEN status IN ('pending', 'dispatched', 'failed', 'blocked', 'outcome_unknown') THEN status ELSE 'failed' END,
  1, created_at, created_at, dispatched_at, error
FROM continuation_dispatches;

DROP TABLE continuation_dispatches;
ALTER TABLE continuation_dispatches_v12 RENAME TO continuation_dispatches;

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
