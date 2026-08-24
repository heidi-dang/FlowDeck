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

fn make_check(
    check_id: &str,
    status: CheckExecutionStatus,
    execution_id: &str,
    reused: bool,
    cmd: Vec<String>,
) -> CheckExecutionResult {
    CheckExecutionResult {
        check_id: check_id.to_string(),
        kind: VerificationCheckKind::UnitTest,
        status,
        execution_id: execution_id.to_string(),
        reused_execution: reused,
        command: cmd,
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
    }
}

fn make_run(run_id: &str, checks: Vec<CheckExecutionResult>) -> VerificationRun {
    let planned = checks.iter().map(|c| planned_check(&c.check_id)).collect();
    VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: planned,
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks,
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10,
    }
}

#[test]
fn test_mixed_physicality_unsupported_first_passed_second_fails_transactionally() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::Unsupported,
            "exec_mixed_1",
            false,
            vec!["node".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Passed,
            "exec_mixed_1",
            true,
            vec!["node".into()],
        ),
    ];
    let run = make_run("run_mixed_1", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));

    // Verify rollback: 0 rows
    let run_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_runs WHERE run_id = 'run_mixed_1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(run_count, 0);
}

#[test]
fn test_mixed_physicality_passed_first_unsupported_second_fails_transactionally() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::Passed,
            "exec_mixed_2",
            false,
            vec!["node".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Unsupported,
            "exec_mixed_2",
            true,
            vec!["node".into()],
        ),
    ];
    let run = make_run("run_mixed_2", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));

    let run_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_runs WHERE run_id = 'run_mixed_2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(run_count, 0);
}

#[test]
fn test_mixed_physicality_spawnfailed_first_passed_second_fails_transactionally() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::SpawnFailed,
            "exec_mixed_3",
            false,
            vec!["node".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Passed,
            "exec_mixed_3",
            true,
            vec!["node".into()],
        ),
    ];
    let run = make_run("run_mixed_3", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_mixed_physicality_passed_first_spawnfailed_second_fails_transactionally() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::Passed,
            "exec_mixed_4",
            false,
            vec!["node".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::SpawnFailed,
            "exec_mixed_4",
            true,
            vec!["node".into()],
        ),
    ];
    let run = make_run("run_mixed_4", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_mixed_physicality_timedout_first_unsupported_second_fails_transactionally() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::TimedOut,
            "exec_mixed_5",
            false,
            vec!["node".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Unsupported,
            "exec_mixed_5",
            true,
            vec!["node".into()],
        ),
    ];
    let run = make_run("run_mixed_5", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_mixed_physicality_outputlimit_first_skipped_second_fails_transactionally() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::OutputLimitExceeded,
            "exec_mixed_6",
            false,
            vec!["node".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Skipped,
            "exec_mixed_6",
            true,
            vec!["node".into()],
        ),
    ];
    let run = make_run("run_mixed_6", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_nonphysical_shared_execution_with_conflicting_commands_fails() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::Unsupported,
            "exec_nonphys_cmd",
            false,
            vec!["npm".into(), "test".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Unsupported,
            "exec_nonphys_cmd",
            true,
            vec!["cargo".into(), "test".into()],
        ),
    ];
    let run = make_run("run_nonphys_cmd", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_nonphysical_shared_execution_with_conflicting_cwd_fails() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let mut check_b = make_check(
        "check_b",
        CheckExecutionStatus::Unsupported,
        "exec_nonphys_cwd",
        true,
        vec!["npm".into()],
    );
    check_b.cwd = "subdir".to_string();
    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::Unsupported,
            "exec_nonphys_cwd",
            false,
            vec!["npm".into()],
        ),
        check_b,
    ];
    let run = make_run("run_nonphys_cwd", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_nonphysical_shared_execution_with_conflicting_duration_fails() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let mut check_b = make_check(
        "check_b",
        CheckExecutionStatus::SpawnFailed,
        "exec_nonphys_dur",
        true,
        vec!["npm".into()],
    );
    check_b.duration_ms = 999;
    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::SpawnFailed,
            "exec_nonphys_dur",
            false,
            vec!["npm".into()],
        ),
        check_b,
    ];
    let run = make_run("run_nonphys_dur", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_shared_execution_two_primaries_fails() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::Passed,
            "exec_two_prim",
            false,
            vec!["npm".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Passed,
            "exec_two_prim",
            false,
            vec!["npm".into()],
        ), // Second primary!
    ];
    let run = make_run("run_two_prim", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_shared_execution_zero_primaries_fails() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::Passed,
            "exec_zero_prim",
            true,
            vec!["npm".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Passed,
            "exec_zero_prim",
            true,
            vec!["npm".into()],
        ),
    ];
    let run = make_run("run_zero_prim", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_singleton_reused_execution_fails() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![make_check(
        "check_a",
        CheckExecutionStatus::Passed,
        "exec_single_reused",
        true,
        vec!["npm".into()],
    )];
    let run = make_run("run_single_reused", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Failed { .. }));
}

#[test]
fn test_valid_shared_physical_execution_has_one_runtime_execution_and_referential_invariant() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::Passed,
            "exec_valid_phys",
            false,
            vec!["npm".into(), "test".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Passed,
            "exec_valid_phys",
            true,
            vec!["npm".into(), "test".into()],
        ),
        make_check(
            "check_c",
            CheckExecutionStatus::Passed,
            "exec_valid_phys",
            true,
            vec!["npm".into(), "test".into()],
        ),
    ];
    let run = make_run("run_valid_phys", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Imported { .. }));

    // Assert 3 check observations, all has_physical_execution = 1
    let check_count: i64 = db.conn.query_row(
        "SELECT count(*) FROM runtime_check_observations WHERE run_id = 'run_valid_phys' AND has_physical_execution = 1",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(check_count, 3);

    // Assert exactly 1 physical execution row
    let exec_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_executions WHERE run_id = 'run_valid_phys'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exec_count, 1);
}

#[test]
fn test_valid_shared_nonphysical_execution_has_zero_runtime_executions_and_referential_invariant() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let checks = vec![
        make_check(
            "check_a",
            CheckExecutionStatus::Unsupported,
            "exec_valid_nonphys",
            false,
            vec!["npm".into(), "test".into()],
        ),
        make_check(
            "check_b",
            CheckExecutionStatus::Unsupported,
            "exec_valid_nonphys",
            true,
            vec!["npm".into(), "test".into()],
        ),
    ];
    let run = make_run("run_valid_nonphys", checks);
    let bytes = serde_json::to_vec(&run).unwrap();
    let res = ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    assert!(matches!(res, RuntimeIngestResult::Imported { .. }));

    // Assert 2 check observations, all has_physical_execution = 0
    let check_count: i64 = db.conn.query_row(
        "SELECT count(*) FROM runtime_check_observations WHERE run_id = 'run_valid_nonphys' AND has_physical_execution = 0",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(check_count, 2);

    // Assert 0 physical execution rows
    let exec_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM runtime_executions WHERE run_id = 'run_valid_nonphys'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(exec_count, 0);
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
