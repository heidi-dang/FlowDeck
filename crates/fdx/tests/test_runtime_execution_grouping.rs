use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::model::RuntimeIngestResult;
use fdx::intelligence::runtime::{
    get_historical_run, ingest_verification_artifact, query_check_statistics,
};
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, VerificationOutcome, VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

fn planned(id: &str) -> PlannedCheck {
    PlannedCheck {
        check_id: id.to_string(),
        display_name: id.to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:.".to_string(),
        reason: "changed".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    }
}

#[test]
fn test_runtime_shared_suite_execution_persists_one_execution_for_multiple_obligations() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        CheckExecutionResult {
            check_id: "test:npm:tests/a.test.ts".to_string(),
            kind: VerificationCheckKind::UnitTest,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_shared_1".to_string(),
            reused_execution: false,
            command: vec!["npm".to_string(), "run".to_string(), "test".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 100,
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
            check_id: "test:npm:tests/b.test.ts".to_string(),
            kind: VerificationCheckKind::UnitTest,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_shared_1".to_string(),
            reused_execution: true,
            command: vec!["npm".to_string(), "run".to_string(), "test".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 100,
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
            check_id: "test:npm:tests/c.test.ts".to_string(),
            kind: VerificationCheckKind::UnitTest,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_shared_1".to_string(),
            reused_execution: true,
            command: vec!["npm".to_string(), "run".to_string(), "test".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 100,
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
    ];

    let run = VerificationRun {
        run_id: "run_shared_exec".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![
                planned("test:npm:tests/a.test.ts"),
                planned("test:npm:tests/b.test.ts"),
                planned("test:npm:tests/c.test.ts"),
            ],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks,
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: fdx::intelligence::verify::model::PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 105,
    };

    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Imported { .. }));

    let (_, executions, check_obs) = get_historical_run(&db.conn, "run_shared_exec")
        .unwrap()
        .unwrap();
    assert_eq!(
        executions.len(),
        1,
        "must persist exactly 1 process execution"
    );
    assert_eq!(check_obs.len(), 3, "must persist 3 check obligations");

    let stats_a = query_check_statistics(&db.conn, "test:npm:tests/a.test.ts")
        .unwrap()
        .unwrap();
    assert_eq!(stats_a.total_observations, 1);
    assert_eq!(stats_a.unique_executions, 1);
    assert_eq!(stats_a.median_duration_ms, Some(100.0));
}
