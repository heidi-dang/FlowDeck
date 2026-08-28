use fdx::intelligence::calibration::model::CalibrationPolicy;
use fdx::intelligence::calibration::{
    get_calibration_run, persist_calibration_run, run_calibration,
};
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
fn test_database_close_and_reopen_preserves_exact_metrics() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

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
        run_id: "run-reopen-1".to_string(),
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
            duration_ms: 15,
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
        duration_ms: 15,
    };

    let policy = CalibrationPolicy::default();
    let cal_run = run_calibration(repo_root, &source_run, &policy).unwrap();

    // Persist and close DB
    {
        let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
        persist_calibration_run(&mut db.conn, &cal_run).unwrap();
    }

    // Reopen in ReadOnly mode
    {
        let db_ro = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
        let (summary, metrics, checks, execs) =
            get_calibration_run(&db_ro.conn, &cal_run.calibration_id)
                .unwrap()
                .unwrap();

        assert_eq!(summary.calibration_id, cal_run.calibration_id);
        assert_eq!(summary.source_run_id, "run-reopen-1");
        assert_eq!(summary.calibration_contract_version, 2);
        assert_eq!(
            summary.source_artifact_sha256.as_deref(),
            Some(cal_run.source_artifact_sha256.as_str())
        );
        assert_eq!(
            summary.record_digest.as_deref(),
            Some(cal_run.record_digest.as_str())
        );
        assert_eq!(
            metrics.candidate_selected_count,
            cal_run.metrics.candidate_selected_count
        );
        assert_eq!(
            metrics.candidate_execution_duration_ms,
            cal_run.metrics.candidate_execution_duration_ms
        );
        assert_eq!(checks.len(), cal_run.checks.len());
        assert_eq!(checks[0].display_name, "packages/core/tests/a.test.ts");
        assert_eq!(checks[0].kind, VerificationCheckKind::UnitTest);
        assert_eq!(checks[0].scope, "pkg:npm:packages/core");
        assert_eq!(checks[0].execution_id.as_deref(), Some("candidate_exec_1"));
        assert!(!checks[0].reused_execution);
        assert_eq!(execs.len(), cal_run.executions.len());
        assert_eq!(
            execs[0].origin,
            fdx::intelligence::calibration::CalibrationExecutionOrigin::CandidateSource
        );
        assert_eq!(execs[0].cwd, ".");
        assert_eq!(execs[0].program, "echo");
    }

    // A corrupt stored enum must surface as an error; it must never be silently rewritten to
    // Unsupported or Custom during query reconstruction.
    {
        let db_rw = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
        db_rw
            .conn
            .execute(
                "UPDATE calibration_checks SET kind = 'corrupt_kind' WHERE calibration_id = ?1",
                rusqlite::params![cal_run.calibration_id],
            )
            .unwrap();
    }
    let db_ro = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    assert!(get_calibration_run(&db_ro.conn, &cal_run.calibration_id).is_err());
}
