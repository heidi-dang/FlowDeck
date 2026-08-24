use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_run;
use fdx::intelligence::runtime::stats::query_check_statistics;
use fdx::intelligence::testplan::model::{VerificationCheckKind, VerificationPlan};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, VerificationOutcome, VerificationRun,
};
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_runtime_flake_signal_and_failure_separation() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let check_id = "test:npm:tests/flaky.test.ts";
    let statuses = [
        CheckExecutionStatus::Passed,
        CheckExecutionStatus::Failed,
        CheckExecutionStatus::Passed,
        CheckExecutionStatus::TimedOut,
    ];

    for (i, status) in statuses.iter().enumerate() {
        let outcome = match status {
            CheckExecutionStatus::Passed => VerificationOutcome::Passed,
            CheckExecutionStatus::Failed => VerificationOutcome::Failed,
            _ => VerificationOutcome::Incomplete,
        };
        let run = VerificationRun {
            run_id: format!("run_flake_{}", i),
            plan: VerificationPlan {
                assurance: AssuranceLevel::Exact,
                changed: vec![],
                impacted_targets: vec![],
                selected_checks: vec![],
                uncertainty: vec![],
                unresolved_obligations: vec![],
            },
            outcome,
            assurance: AssuranceLevel::Exact,
            checks: vec![CheckExecutionResult {
                check_id: check_id.to_string(),
                kind: VerificationCheckKind::UnitTest,
                status: *status,
                execution_id: format!("exec_{}", i),
                reused_execution: false,
                command: vec!["npm".to_string()],
                cwd: ".".to_string(),
                exit_code: if *status == CheckExecutionStatus::Passed {
                    Some(0)
                } else {
                    Some(1)
                },
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
                started_at_ms: 1000 + i as u64,
                reason: None,
            }],
            uncertainty: vec![],
            base: None,
            head: None,
            persistence_status: fdx::intelligence::verify::model::PersistenceStatus::NotRequested,
            executed_at_ms: 1000 + i as u64,
            duration_ms: 60,
        };
        ingest_verification_run(&mut db.conn, &run, None).unwrap();
    }

    let stats = query_check_statistics(&db.conn, check_id).unwrap().unwrap();
    assert_eq!(stats.total_observations, 4);
    assert_eq!(stats.pass_count, 2);
    assert_eq!(stats.real_failure_count, 1);
    assert_eq!(stats.incomplete_count, 1);
    assert!(stats.flake_signal.is_flake_signal_present);
}
