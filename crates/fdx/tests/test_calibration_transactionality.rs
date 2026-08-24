use fdx::intelligence::calibration::model::CalibrationPolicy;
use fdx::intelligence::calibration::{persist_calibration_run, run_calibration};
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
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
fn test_transaction_rollback_leaves_zero_orphaned_rows_on_error() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();

    let check = PlannedCheck {
        check_id: "test:npm:packages/core/tests/a.test.ts".to_string(),
        display_name: "packages/core/tests/a.test.ts".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:packages/core".to_string(),
        reason: "selected".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };

    let source_run = VerificationRun {
        run_id: "run-tx-1".to_string(),
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
            command: vec!["echo".to_string(), "ok".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 10,
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
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10,
    };

    let policy = CalibrationPolicy::default();
    let cal_run = run_calibration(repo_root, &source_run, &policy).unwrap();

    // Cause a foreign key error or create duplicate checks with invalid schema constraint
    let mut invalid_run = cal_run.clone();
    // Add a duplicate check to trigger PRIMARY KEY(calibration_id, check_id) violation
    invalid_run.checks.push(invalid_run.checks[0].clone());

    let res = persist_calibration_run(&mut db.conn, &invalid_run);
    assert!(
        res.is_err(),
        "Duplicate check key should trigger transaction abort"
    );

    // Verify 0 rows in calibration tables
    let run_count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM calibration_runs", [], |r| r.get(0))
        .unwrap();
    let check_count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM calibration_checks", [], |r| r.get(0))
        .unwrap();
    let exec_count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM calibration_executions", [], |r| {
            r.get(0)
        })
        .unwrap();
    let metric_count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM calibration_metrics", [], |r| r.get(0))
        .unwrap();

    assert_eq!(run_count, 0);
    assert_eq!(check_count, 0);
    assert_eq!(exec_count, 0);
    assert_eq!(metric_count, 0);
}
