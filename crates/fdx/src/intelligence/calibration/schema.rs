//! SQLite schema and migration definitions for M10 Shadow Calibration.

pub const CALIBRATION_SCHEMA_VERSION: u32 = 9;

/// Migration SQL for v7 -> v8 (Milestone 10 Shadow Calibration tables).
/// Immutable historical migration: never edit in place.
pub const MIGRATE_V7_TO_V8_SQL: &str = r#"
-- Top-level shadow calibration runs
CREATE TABLE IF NOT EXISTS calibration_runs (
    calibration_id TEXT PRIMARY KEY,
    source_run_id TEXT NOT NULL,
    candidate_plan_digest TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    status TEXT NOT NULL,
    reference_scope TEXT NOT NULL,
    max_shadow_checks INTEGER NOT NULL,
    reference_truncated BOOLEAN NOT NULL DEFAULT 0,
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calibration_runs_source ON calibration_runs(source_run_id);
CREATE INDEX IF NOT EXISTS idx_calibration_runs_status ON calibration_runs(status);

-- Shadow check observations
CREATE TABLE IF NOT EXISTS calibration_checks (
    calibration_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    candidate_selected BOOLEAN NOT NULL,
    reference_selected BOOLEAN NOT NULL DEFAULT 1,
    execution_status TEXT NOT NULL,
    has_physical_execution BOOLEAN NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    signal_class TEXT NOT NULL,
    is_observed_shadow_miss BOOLEAN NOT NULL DEFAULT 0,
    reason TEXT,
    PRIMARY KEY(calibration_id, check_id),
    FOREIGN KEY(calibration_id) REFERENCES calibration_runs(calibration_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_calibration_checks_cal_id ON calibration_checks(calibration_id);
CREATE INDEX IF NOT EXISTS idx_calibration_checks_signal ON calibration_checks(signal_class);
CREATE INDEX IF NOT EXISTS idx_calibration_checks_miss ON calibration_checks(is_observed_shadow_miss);

-- Shadow process executions
CREATE TABLE IF NOT EXISTS calibration_executions (
    calibration_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    program TEXT NOT NULL,
    argv_digest TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER NOT NULL,
    stdout_digest TEXT,
    stderr_digest TEXT,
    PRIMARY KEY(calibration_id, execution_id),
    FOREIGN KEY(calibration_id) REFERENCES calibration_runs(calibration_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_calibration_executions_cal_id ON calibration_executions(calibration_id);

-- Calibration metrics and eligibility
CREATE TABLE IF NOT EXISTS calibration_metrics (
    calibration_id TEXT PRIMARY KEY,
    candidate_selected_count INTEGER NOT NULL,
    shadow_reference_count INTEGER NOT NULL,
    shadow_executed_count INTEGER NOT NULL,
    selected_failure_count INTEGER NOT NULL,
    unselected_failure_count INTEGER NOT NULL,
    observed_shadow_miss_count INTEGER NOT NULL,
    shadow_incomplete_count INTEGER NOT NULL,
    candidate_execution_duration_ms INTEGER NOT NULL,
    shadow_reference_duration_ms INTEGER NOT NULL,
    selection_ratio REAL,
    runtime_cost_ratio REAL,
    signal_recall REAL,
    eligible_for_miss_rate BOOLEAN NOT NULL,
    eligible_for_cost_ratio BOOLEAN NOT NULL,
    eligible_for_runtime_comparison BOOLEAN NOT NULL,
    FOREIGN KEY(calibration_id) REFERENCES calibration_runs(calibration_id) ON DELETE CASCADE
);
"#;

/// Additive v8 -> v9 migration for qualified M10 evidence. Historical v8 rows are explicitly
/// retained as contract version 1 and do not acquire fabricated check or execution metadata.
pub const MIGRATE_V8_TO_V9_SQL: &str = r#"
ALTER TABLE calibration_runs ADD COLUMN calibration_contract_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE calibration_runs ADD COLUMN source_artifact_sha256 TEXT;
ALTER TABLE calibration_runs ADD COLUMN record_digest TEXT;
ALTER TABLE calibration_runs ADD COLUMN max_total_duration_ms INTEGER;
ALTER TABLE calibration_runs ADD COLUMN per_check_timeout_ms INTEGER;
ALTER TABLE calibration_runs ADD COLUMN max_output_bytes INTEGER;

ALTER TABLE calibration_checks ADD COLUMN display_name TEXT;
ALTER TABLE calibration_checks ADD COLUMN kind TEXT;
ALTER TABLE calibration_checks ADD COLUMN scope TEXT;
ALTER TABLE calibration_checks ADD COLUMN execution_id TEXT;
ALTER TABLE calibration_checks ADD COLUMN reused_execution BOOLEAN;

ALTER TABLE calibration_executions ADD COLUMN origin TEXT;

ALTER TABLE calibration_metrics ADD COLUMN candidate_physical_execution_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calibration_metrics ADD COLUMN shadow_physical_execution_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_calibration_runs_qualified
    ON calibration_runs(source_run_id, candidate_plan_digest, policy_digest, calibration_contract_version);
CREATE INDEX IF NOT EXISTS idx_calibration_runs_record_digest ON calibration_runs(record_digest);
CREATE INDEX IF NOT EXISTS idx_calibration_checks_execution ON calibration_checks(calibration_id, execution_id);
"#;
