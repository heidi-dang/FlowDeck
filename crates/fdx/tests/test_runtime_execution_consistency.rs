use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::runtime::model::RuntimeIngestResult;
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

fn planned_check(check_id: &str) -> PlannedCheck {
    PlannedCheck {
        check_id: check_id.to_string(),
        display_name: check_id.to_string(),
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
fn test_shared_execution_with_conflicting_commands_fails_transactionally() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = VerificationRun {
        run_id: "run_conflict_cmd".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![planned_check("check_a"), planned_check("check_b")],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![
            CheckExecutionResult {
                check_id: "check_a".to_string(),
                kind: VerificationCheckKind::UnitTest,
                status: CheckExecutionStatus::Passed,
                execution_id: "shared_exec_1".to_string(),
                reused_execution: false,
                command: vec!["npm".to_string(), "test".to_string()],
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
                check_id: "check_b".to_string(),
                kind: VerificationCheckKind::UnitTest,
                status: CheckExecutionStatus::Passed,
                execution_id: "shared_exec_1".to_string(),
                reused_execution: true,
                command: vec!["cargo".to_string(), "test".to_string()], // Conflicting command!
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
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10,
    };

    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));

    // Ensure entire transaction rolled back: 0 runs stored
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_runs WHERE run_id = 'run_conflict_cmd'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_shared_execution_with_conflicting_status_fails_transactionally() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = VerificationRun {
        run_id: "run_conflict_status".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![planned_check("check_a"), planned_check("check_b")],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Incomplete,
        assurance: AssuranceLevel::Exact,
        checks: vec![
            CheckExecutionResult {
                check_id: "check_a".to_string(),
                kind: VerificationCheckKind::UnitTest,
                status: CheckExecutionStatus::Passed,
                execution_id: "shared_exec_2".to_string(),
                reused_execution: false,
                command: vec!["npm".to_string(), "test".to_string()],
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
                check_id: "check_b".to_string(),
                kind: VerificationCheckKind::UnitTest,
                status: CheckExecutionStatus::Failed, // Conflicting status!
                execution_id: "shared_exec_2".to_string(),
                reused_execution: true,
                command: vec!["npm".to_string(), "test".to_string()],
                cwd: ".".to_string(),
                exit_code: Some(1),
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
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10,
    };

    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));

    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_runs WHERE run_id = 'run_conflict_status'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_unplanned_check_fails_ingestion() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = VerificationRun {
        run_id: "run_unplanned".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![planned_check("check_planned")], // check_unplanned is not here!
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: "check_unplanned".to_string(),
            kind: VerificationCheckKind::UnitTest,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_unplanned".to_string(),
            reused_execution: false,
            command: vec!["npm".to_string(), "test".to_string()],
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

    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}
