export const MIGRATION_V10_HEIDI_RUNTIME_CLOSURE_SQL = `
CREATE TABLE IF NOT EXISTS heidi_completion_reviews (
 id TEXT PRIMARY KEY, completion_key TEXT NOT NULL UNIQUE, session_id TEXT, task_run_id TEXT, status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')), candidate_id TEXT, error TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS heidi_delegation_activity (
 child_id TEXT PRIMARY KEY, parent_session_id TEXT, parent_task_run_id TEXT, specialist TEXT NOT NULL, goal TEXT, state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','cancelled','timed_out','stalled','unknown')), created_at TEXT NOT NULL, started_at TEXT, last_activity_at TEXT, finished_at TEXT, tool_calls INTEGER NOT NULL DEFAULT 0, tokens INTEGER, cost REAL, files_touched TEXT NOT NULL DEFAULT '[]', phase TEXT, current_tool TEXT, summary TEXT, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, steering_state TEXT NOT NULL DEFAULT 'none'
);
CREATE TABLE IF NOT EXISTS heidi_delegation_controls (
 id TEXT PRIMARY KEY, child_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('cancel','steer')), instruction TEXT, status TEXT NOT NULL CHECK(status IN ('queued','delivered','applied','rejected','unsupported','terminal')), created_at TEXT NOT NULL, acknowledged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_heidi_delegation_parent ON heidi_delegation_activity(parent_session_id, state);
CREATE INDEX IF NOT EXISTS idx_heidi_delegation_state ON heidi_delegation_activity(state, last_activity_at);
`;
