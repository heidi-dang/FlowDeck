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
fn test_secrets_in_unsupported_reasons_or_environment_are_redacted() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();

    let secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let project_secret = "sk-proj-secret-value";
    let private_path = "/home/private-user/project";
    let check = PlannedCheck {
        check_id: "test:npm:packages/core/tests/a.test.ts".to_string(),
        display_name: "packages/core/tests/a.test.ts".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:packages/core".to_string(),
        reason: format!("failed with secret {}", secret),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };

    let source_run = VerificationRun {
        run_id: "run-priv-1".to_string(),
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
            command: vec![format!("{private_path}/bin/echo"), "ok".to_string()],
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
            reason: Some(format!(
                "Bearer secret-value {secret} {project_secret} under {private_path}"
            )),
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
    persist_calibration_run(&mut db.conn, &cal_run).unwrap();

    // Scan every M10 persistence table rather than only a planned-check reason.
    let raw_db_str: String = db
        .conn
        .query_row(
            r#"
            SELECT group_concat(value, ' ') FROM (
                SELECT calibration_id || ' ' || source_run_id || ' ' ||
                       coalesce(source_artifact_sha256, '') || ' ' ||
                       coalesce(record_digest, '') AS value
                FROM calibration_runs
                UNION ALL
                SELECT check_id || ' ' || coalesce(reason, '') || ' ' ||
                       coalesce(display_name, '') || ' ' || coalesce(scope, '')
                FROM calibration_checks
                UNION ALL
                SELECT execution_id || ' ' || program || ' ' || cwd || ' ' || argv_digest
                FROM calibration_executions
                UNION ALL
                SELECT calibration_id FROM calibration_metrics
            )
            "#,
            [],
            |row| row.get(0),
        )
        .unwrap();
    for forbidden in [secret, project_secret, private_path, "Bearer secret-value"] {
        assert!(
            !raw_db_str.contains(forbidden),
            "raw sensitive value must not be persisted: {forbidden}"
        );
    }
    assert!(
        raw_db_str.contains("echo"),
        "absolute program identity should be normalized"
    );
    assert!(!raw_db_str.contains("/home/"));
}
