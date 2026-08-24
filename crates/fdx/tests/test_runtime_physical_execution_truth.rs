use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::runtime::model::RuntimeIngestResult;
use fdx::intelligence::runtime::stats::query_check_statistics;
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

fn make_run_with_check(
    run_id: &str,
    check_id: &str,
    status: CheckExecutionStatus,
    exec_id: &str,
    cmd: Vec<String>,
) -> VerificationRun {
    VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![PlannedCheck {
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
            }],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: if status == CheckExecutionStatus::Passed {
            VerificationOutcome::Passed
        } else {
            VerificationOutcome::Incomplete
        },
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: check_id.to_string(),
            kind: VerificationCheckKind::UnitTest,
            status,
            execution_id: exec_id.to_string(),
            reused_execution: false,
            command: cmd,
            cwd: ".".to_string(),
            exit_code: if status == CheckExecutionStatus::Passed {
                Some(0)
            } else {
                None
            },
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
    }
}

#[test]
fn test_unsupported_check_creates_zero_runtime_executions() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = make_run_with_check(
        "run_unsupp",
        "check:unsupp",
        CheckExecutionStatus::Unsupported,
        "unsupported:check:unsupp",
        vec![],
    );
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Imported { .. }));

    // Check observations count = 1
    let check_obs_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_check_observations WHERE run_id = 'run_unsupp'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(check_obs_count, 1);

    // Runtime executions count = 0 (no physical execution!)
    let exec_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_executions WHERE run_id = 'run_unsupp'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exec_count, 0);

    // Statistics: 1 observation, 0 unique executions, 1 incomplete
    let stats = query_check_statistics(&db.conn, "check:unsupp")
        .unwrap()
        .unwrap();
    assert_eq!(stats.total_observations, 1);
    assert_eq!(stats.unique_executions, 0);
    assert_eq!(stats.incomplete_count, 1);
}

#[test]
fn test_skipped_check_creates_zero_runtime_executions() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = make_run_with_check(
        "run_skip",
        "check:skip",
        CheckExecutionStatus::Skipped,
        "skipped:check:skip",
        vec![],
    );
    let bytes = serde_json::to_vec(&run).unwrap();
    ingest_verification_artifact(&mut db.conn, &bytes).unwrap();

    let exec_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_executions WHERE run_id = 'run_skip'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exec_count, 0);

    let stats = query_check_statistics(&db.conn, "check:skip")
        .unwrap()
        .unwrap();
    assert_eq!(stats.total_observations, 1);
    assert_eq!(stats.unique_executions, 0);
    assert_eq!(stats.incomplete_count, 1);
}

#[test]
fn test_spawn_failed_creates_zero_runtime_executions() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = make_run_with_check(
        "run_spawn_fail",
        "check:spawn_fail",
        CheckExecutionStatus::SpawnFailed,
        "spawn_fail:check:spawn_fail",
        vec!["invalid_binary".to_string()],
    );
    let bytes = serde_json::to_vec(&run).unwrap();
    ingest_verification_artifact(&mut db.conn, &bytes).unwrap();

    let exec_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_executions WHERE run_id = 'run_spawn_fail'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exec_count, 0);

    let stats = query_check_statistics(&db.conn, "check:spawn_fail")
        .unwrap()
        .unwrap();
    assert_eq!(stats.total_observations, 1);
    assert_eq!(stats.unique_executions, 0);
    assert_eq!(stats.incomplete_count, 1);
}

#[test]
fn test_passed_and_failed_checks_create_physical_executions() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = make_run_with_check(
        "run_passed",
        "check:pass",
        CheckExecutionStatus::Passed,
        "exec_pass_1",
        vec!["cargo".to_string(), "test".to_string()],
    );
    let bytes = serde_json::to_vec(&run).unwrap();
    ingest_verification_artifact(&mut db.conn, &bytes).unwrap();

    let exec_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_executions WHERE run_id = 'run_passed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exec_count, 1);

    let stats = query_check_statistics(&db.conn, "check:pass")
        .unwrap()
        .unwrap();
    assert_eq!(stats.total_observations, 1);
    assert_eq!(stats.unique_executions, 1);
    assert_eq!(stats.pass_count, 1);
}
