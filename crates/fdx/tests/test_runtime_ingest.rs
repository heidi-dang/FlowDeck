use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::model::RuntimeIngestResult;
use fdx::intelligence::runtime::{
    get_historical_run, ingest_verification_artifact, list_historical_runs,
};
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, VerificationOutcome, VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

fn dummy_run(run_id: &str) -> VerificationRun {
    VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![PlannedCheck {
                check_id: "check:pkg:npm:.:test".to_string(),
                display_name: "test".to_string(),
                kind: VerificationCheckKind::UnitTest,
                scope: "pkg:npm:.".to_string(),
                reason: "changed".to_string(),
                selection: SelectionReason::Evidence,
                strength: EvidenceStrength::Precise,
                evidence_path: None,
                evidence_refs: vec![],
                widening_reason: None,
                mandatory: true,
            }],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: "check:pkg:npm:.:test".to_string(),
            kind: VerificationCheckKind::UnitTest,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_1".to_string(),
            reused_execution: false,
            command: vec!["npm".to_string(), "run".to_string(), "test".to_string()],
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
        persistence_status: fdx::intelligence::verify::model::PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 55,
    }
}

#[test]
fn test_runtime_ingest_single_run_and_query() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = dummy_run("run_test_1");
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Imported { .. }));

    let runs = list_historical_runs(&db.conn, 10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run_id, "run_test_1");
    assert_eq!(runs[0].outcome, VerificationOutcome::Passed);

    let details = get_historical_run(&db.conn, "run_test_1").unwrap().unwrap();
    assert_eq!(details.0.run_id, "run_test_1");
    assert_eq!(details.1.len(), 1); // 1 execution
    assert_eq!(details.2.len(), 1); // 1 check
}
