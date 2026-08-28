//! SQLite schema and migration definitions for M8 Runtime Verification History.

pub const RUNTIME_SCHEMA_VERSION: u32 = 7;

/// Migration SQL for v5 -> v6 (Milestone 8 Runtime Verification History tables).
/// Immutable historical migration: never edit in place.
pub const MIGRATE_V5_TO_V6_SQL: &str = r#"
-- Top-level verification runs
CREATE TABLE IF NOT EXISTS runtime_runs (
    run_id TEXT PRIMARY KEY,
    artifact_digest TEXT NOT NULL,
    plan_digest TEXT NOT NULL,
    outcome TEXT NOT NULL,
    assurance TEXT NOT NULL,
    executed_at_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    base_ref TEXT,
    head_ref TEXT,
    imported_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_runs_executed ON runtime_runs(executed_at_ms);
CREATE INDEX IF NOT EXISTS idx_runtime_runs_outcome ON runtime_runs(outcome);

-- Unique process executions
CREATE TABLE IF NOT EXISTS runtime_executions (
    run_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    program TEXT NOT NULL,
    argv_digest TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER NOT NULL,
    stdout_digest TEXT,
    stderr_digest TEXT,
    stdout_captured_bytes INTEGER NOT NULL DEFAULT 0,
    stderr_captured_bytes INTEGER NOT NULL DEFAULT 0,
    output_truncated BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY(run_id, execution_id),
    FOREIGN KEY(run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_executions_status ON runtime_executions(status);

-- Verification check obligations mapped to executions
CREATE TABLE IF NOT EXISTS runtime_check_observations (
    run_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    reused_execution BOOLEAN NOT NULL DEFAULT 0,
    mandatory BOOLEAN NOT NULL DEFAULT 1,
    PRIMARY KEY(run_id, check_id),
    FOREIGN KEY(run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_check_obs_check_id ON runtime_check_observations(check_id);
CREATE INDEX IF NOT EXISTS idx_runtime_check_obs_status ON runtime_check_observations(status);

-- Changed entity co-occurrence observation
CREATE TABLE IF NOT EXISTS runtime_change_observations (
    run_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    PRIMARY KEY(run_id, entity_id, entity_kind),
    FOREIGN KEY(run_id) REFERENCES runtime_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_change_obs_entity ON runtime_change_observations(entity_id);

-- Ingestion status and reconciliation tracking
CREATE TABLE IF NOT EXISTS runtime_ingestion_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

/// Migration SQL for v6 -> v7 (Milestone 8 Runtime Verification History hardening).
///
/// v7 additions:
/// - runtime_runs.ingestion_contract_version (1 = legacy/unqualified v6, 2 = exact-byte v7)
/// - runtime_check_observations.has_physical_execution (boolean indicating physical OS process)
pub const MIGRATE_V6_TO_V7_SQL: &str = r#"
ALTER TABLE runtime_runs ADD COLUMN ingestion_contract_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE runtime_check_observations ADD COLUMN has_physical_execution BOOLEAN NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_runtime_runs_contract ON runtime_runs(ingestion_contract_version);
"#;
