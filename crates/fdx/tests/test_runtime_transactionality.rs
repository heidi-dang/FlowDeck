use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::{VerificationCheckKind, VerificationPlan};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, VerificationOutcome, VerificationRun,
};
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_runtime_transaction_rollback_leaves_zero_rows_on_corrupt_check() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    // Duplicate check_id triggers validation failure before transaction commit
    let run = VerificationRun {
        run_id: "run_tx_fail".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![
            CheckExecutionResult {
                check_id: "duplicate_id".to_string(),
                kind: VerificationCheckKind::UnitTest,
                status: CheckExecutionStatus::Passed,
                execution_id: "e1".to_string(),
                reused_execution: false,
                command: vec!["npm".to_string()],
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
            },
            CheckExecutionResult {
                check_id: "duplicate_id".to_string(),
                kind: VerificationCheckKind::UnitTest,
                status: CheckExecutionStatus::Passed,
                execution_id: "e2".to_string(),
                reused_execution: false,
                command: vec!["npm".to_string()],
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
            },
        ],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: fdx::intelligence::verify::model::PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 20,
    };

    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(
        res,
        fdx::intelligence::runtime::model::RuntimeIngestResult::Failed { .. }
    ));

    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_runs WHERE run_id='run_tx_fail'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0, "no runtime_runs rows must exist after failure");
}
