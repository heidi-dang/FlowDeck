//! Additive Milestone 11 schema migration. Published v1-v9 migrations remain immutable.

pub const MIGRATE_V9_TO_V10_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS policy_candidates (
    candidate_id TEXT PRIMARY KEY,
    candidate_contract_version INTEGER NOT NULL,
    trigger_kind TEXT NOT NULL,
    trigger_scope TEXT NOT NULL,
    check_id TEXT NOT NULL,
    candidate_digest TEXT NOT NULL,
    promotion_policy_digest TEXT NOT NULL,
    support_count INTEGER NOT NULL,
    distinct_source_artifact_count INTEGER NOT NULL,
    distinct_change_fingerprint_count INTEGER NOT NULL,
    estimated_added_runtime_ms INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    promoted_policy_id TEXT,
    UNIQUE(candidate_contract_version, trigger_kind, trigger_scope, check_id, promotion_policy_digest)
);

CREATE TABLE IF NOT EXISTS policy_candidate_evidence (
    candidate_id TEXT NOT NULL,
    calibration_id TEXT NOT NULL,
    source_artifact_sha256 TEXT NOT NULL,
    candidate_plan_digest TEXT NOT NULL,
    calibration_record_digest TEXT NOT NULL,
    check_id TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    PRIMARY KEY(candidate_id, calibration_id, check_id),
    FOREIGN KEY(candidate_id) REFERENCES policy_candidates(candidate_id) ON DELETE CASCADE,
    FOREIGN KEY(calibration_id) REFERENCES calibration_runs(calibration_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS policy_check_templates (
    template_digest TEXT PRIMARY KEY,
    check_id TEXT NOT NULL,
    planned_check_json TEXT NOT NULL,
    source_calibration_id TEXT NOT NULL,
    source_artifact_sha256 TEXT NOT NULL,
    source_record_digest TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY(source_calibration_id) REFERENCES calibration_runs(calibration_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS promoted_policies (
    policy_id TEXT PRIMARY KEY,
    policy_contract_version INTEGER NOT NULL,
    candidate_id TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    trigger_scope TEXT NOT NULL,
    check_id TEXT NOT NULL,
    template_digest TEXT,
    candidate_digest TEXT NOT NULL,
    promotion_policy_digest TEXT NOT NULL,
    promoted_policy_digest TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    promoted_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,
    revoke_reason TEXT,
    FOREIGN KEY(candidate_id) REFERENCES policy_candidates(candidate_id) ON DELETE RESTRICT,
    FOREIGN KEY(template_digest) REFERENCES policy_check_templates(template_digest) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS policy_events (
    event_id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    event_digest TEXT NOT NULL UNIQUE,
    reason TEXT,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY(policy_id) REFERENCES promoted_policies(policy_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS policy_applications (
    application_id TEXT PRIMARY KEY,
    base_plan_digest TEXT NOT NULL,
    policy_snapshot_digest TEXT NOT NULL,
    effective_plan_digest TEXT NOT NULL,
    added_check_ids_json TEXT NOT NULL,
    application_digest TEXT NOT NULL UNIQUE,
    applied_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policy_check_templates_check ON policy_check_templates(check_id, template_digest);
CREATE INDEX IF NOT EXISTS idx_policy_candidates_state ON policy_candidates(state, updated_at_ms, candidate_id);
CREATE INDEX IF NOT EXISTS idx_policy_candidate_evidence_artifact ON policy_candidate_evidence(source_artifact_sha256);
CREATE INDEX IF NOT EXISTS idx_promoted_policies_active ON promoted_policies(state, trigger_kind, trigger_scope, check_id);
CREATE INDEX IF NOT EXISTS idx_policy_events_policy ON policy_events(policy_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_policy_applications_snapshot ON policy_applications(policy_snapshot_digest, application_id);
"#;
