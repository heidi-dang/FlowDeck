use fdx::intelligence::attestation::build_verification_attestation;
use fdx::intelligence::attestation::canonical::canonicalize_to_vec;
use fdx::intelligence::calibration::model::CalibrationPolicy;
use fdx::intelligence::calibration::{persist_calibration_run, run_calibration};
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_m9_attestation_bytes_and_hashes_remain_identical_before_and_after_calibration() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();

    let check = PlannedCheck {
        check_id: "test:cargo:tests/test_a.rs".to_string(),
        display_name: "tests/test_a.rs".to_string(),
        kind: VerificationCheckKind::IntegrationTest,
        scope: "pkg:cargo:crates/a".to_string(),
        reason: "selected".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };

    let source_run = VerificationRun {
        run_id: "019184a2-7b3e-7b3c-9452-19e491c1d810".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![check.clone()],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: check.check_id.clone(),
            kind: check.kind,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_1".to_string(),
            reused_execution: false,
            command: vec!["cargo".to_string(), "test".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 50,
            stdout_digest: None,
            stderr_digest: None,
            stdout_excerpt: None,
            stderr_excerpt: None,
            stdout_captured_bytes: 0,
            stderr_captured_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            started_at_ms: 1000,
            reason: None,
        }],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::Persisted {
            path: ".fdx/runs/019184a2-7b3e-7b3c-9452-19e491c1d810.json".to_string(),
        },
        executed_at_ms: 1000,
        duration_ms: 50,
    };

    let run_dir = repo_root.join(".fdx").join("runs");
    std::fs::create_dir_all(&run_dir).unwrap();
    let run_path = run_dir.join("019184a2-7b3e-7b3c-9452-19e491c1d810.json");
    let raw_run_bytes = serde_json::to_vec(&source_run).unwrap();
    std::fs::write(&run_path, &raw_run_bytes).unwrap();

    // Ingest into M8 history
    ingest_verification_artifact(&mut db.conn, &raw_run_bytes).unwrap();

    // Build M9 attestation before calibration
    let statement_before =
        build_verification_attestation(repo_root, &source_run.run_id, &db.conn).unwrap();
    let jcs_bytes_before = canonicalize_to_vec(&statement_before).unwrap();

    // Now run calibration and persist calibration records
    let policy = CalibrationPolicy::default();
    let cal_run = run_calibration(repo_root, &source_run, &policy).unwrap();
    persist_calibration_run(&mut db.conn, &cal_run).unwrap();

    // Build M9 attestation after calibration
    let statement_after =
        build_verification_attestation(repo_root, &source_run.run_id, &db.conn).unwrap();
    let jcs_bytes_after = canonicalize_to_vec(&statement_after).unwrap();

    // Exact byte equality
    assert_eq!(jcs_bytes_before, jcs_bytes_after);
    assert_eq!(statement_before, statement_after);
}
