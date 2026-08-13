export const MIGRATION_V11_HEIDI_PARALLEL_ENGINE_SQL = `
CREATE TABLE IF NOT EXISTS heidi_delegation_runs (
  run_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS heidi_delegation_nodes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  specialist TEXT NOT NULL,
  goal TEXT NOT NULL,
  dependencies TEXT NOT NULL DEFAULT '[]',
  access TEXT NOT NULL CHECK(access IN ('read', 'write')),
  file_scopes TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  estimated_complexity TEXT NOT NULL CHECK(estimated_complexity IN ('small', 'normal', 'large')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'reserved', 'dispatching', 'running', 'completed', 'failed', 'cancel_pending', 'cancelled', 'blocked')),
  child_session_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  summary TEXT,
  error TEXT,
  result_json TEXT,
  FOREIGN KEY (run_id) REFERENCES heidi_delegation_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_heidi_delegation_nodes_run ON heidi_delegation_nodes(run_id, status);
CREATE INDEX IF NOT EXISTS idx_heidi_delegation_nodes_session ON heidi_delegation_nodes(child_session_id);
`;
