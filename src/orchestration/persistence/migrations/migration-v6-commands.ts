/** v0.2.11 durable canonical command invocations. */
export const MIGRATION_V6_COMMANDS_SQL = `
CREATE TABLE IF NOT EXISTS command_invocations (
  invocation_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  command_version INTEGER NOT NULL CHECK(command_version > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','running','verifying','completed','failed','cancelled')),
  task_run_id TEXT,
  plan_id TEXT,
  result_json TEXT,
  error_json TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_command_invocations_run ON command_invocations(task_run_id);
CREATE INDEX IF NOT EXISTS idx_command_invocations_command ON command_invocations(command_id, command_version);
`;
