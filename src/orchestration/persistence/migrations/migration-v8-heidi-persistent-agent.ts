/** Durable Heidi memory, session recall, learning, skills, and scheduler foundation. */
export const MIGRATION_V8_HEIDI_PERSISTENT_AGENT_SQL = `
CREATE TABLE IF NOT EXISTS heidi_memory (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('user','agent','repo')),
  kind TEXT NOT NULL, canonical_key TEXT, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','inactive','quarantined')),
  confidence REAL NOT NULL DEFAULT 0 CHECK(confidence >= 0 AND confidence <= 1), source_type TEXT NOT NULL,
  source_session_id TEXT, source_task_run_id TEXT, source_agent TEXT, source_commit_sha TEXT,
  evidence_refs TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, quarantine_reason TEXT,
  UNIQUE(scope, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_heidi_memory_scope_status ON heidi_memory(scope, status, confidence DESC);
CREATE TABLE IF NOT EXISTS heidi_memory_versions (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
  status TEXT NOT NULL, confidence REAL NOT NULL, provenance TEXT NOT NULL, changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL, UNIQUE(memory_id, version), FOREIGN KEY(memory_id) REFERENCES heidi_memory(id)
);
CREATE TABLE IF NOT EXISTS heidi_session_archive (
  session_id TEXT PRIMARY KEY, source TEXT NOT NULL, repository TEXT, task_run_id TEXT,
  agent TEXT, started_at TEXT, ended_at TEXT, archived_at TEXT NOT NULL, compressed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS heidi_session_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, tool_summary TEXT, created_at TEXT NOT NULL,
  UNIQUE(session_id, sequence), FOREIGN KEY(session_id) REFERENCES heidi_session_archive(session_id) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE IF NOT EXISTS heidi_session_messages_fts USING fts5(
  content, tool_summary, content='heidi_session_messages', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS heidi_session_messages_ai AFTER INSERT ON heidi_session_messages BEGIN
  INSERT INTO heidi_session_messages_fts(rowid, content, tool_summary) VALUES (new.rowid, new.content, new.tool_summary);
END;
CREATE TRIGGER IF NOT EXISTS heidi_session_messages_ad AFTER DELETE ON heidi_session_messages BEGIN
  INSERT INTO heidi_session_messages_fts(heidi_session_messages_fts, rowid, content, tool_summary) VALUES ('delete', old.rowid, old.content, old.tool_summary);
END;
CREATE TABLE IF NOT EXISTS heidi_audit (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, subject_id TEXT, session_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
`;
