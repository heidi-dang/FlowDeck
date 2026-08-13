export const MIGRATION_V9_HEIDI_LEARNING_RUNTIME_SQL = `
CREATE TABLE IF NOT EXISTS heidi_learning_candidates (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','applied','rolled_back')),
 content TEXT NOT NULL, provenance TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 0,
 source_session_id TEXT, source_task_run_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, decision_by TEXT, applied_id TEXT, UNIQUE(source_session_id, type, content)
);
CREATE TABLE IF NOT EXISTS heidi_learning_events (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(candidate_id) REFERENCES heidi_learning_candidates(id));
CREATE TABLE IF NOT EXISTS heidi_learned_skills (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, ownership TEXT NOT NULL CHECK(ownership IN ('user','project','learned','external','core')),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','quarantined')), version INTEGER NOT NULL DEFAULT 1, content TEXT NOT NULL,
 metadata TEXT NOT NULL DEFAULT '{}', confidence REAL NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_candidate_id TEXT
);
CREATE TABLE IF NOT EXISTS heidi_skill_versions (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, changed_at TEXT NOT NULL, changed_by TEXT NOT NULL, UNIQUE(skill_id, version), FOREIGN KEY(skill_id) REFERENCES heidi_learned_skills(id));
CREATE TABLE IF NOT EXISTS heidi_scheduled_jobs (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once','interval','cron')), schedule TEXT NOT NULL, timezone TEXT NOT NULL,
 workspace TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, lease_until TEXT, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS heidi_scheduled_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, occurrence TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','claimed','running','completed','failed','cancelled','unknown')), started_at TEXT, finished_at TEXT, error TEXT, UNIQUE(job_id, occurrence), FOREIGN KEY(job_id) REFERENCES heidi_scheduled_jobs(id));
CREATE INDEX IF NOT EXISTS idx_heidi_jobs_due ON heidi_scheduled_jobs(enabled, next_run_at);
`;
