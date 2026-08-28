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
fn test_persisting_divergent_data_with_same_id_fails_conflict() {
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
        run_id: "run-conflict-1".to_string(),
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

    // Persist first
    persist_calibration_run(&mut db.conn, &cal_run).unwrap();

    // Every evidence-bearing field must conflict under the same deterministic key.
    let mut changed_plan = cal_run.clone();
    changed_plan.candidate_plan_digest = "tampered_plan_digest".to_string();
    let mut changed_check = cal_run.clone();
    changed_check.checks[0].execution_status = CheckExecutionStatus::Failed;
    let mut changed_execution = cal_run.clone();
    changed_execution.executions[0].duration_ms += 1;
    let mut changed_metrics = cal_run.clone();
    changed_metrics.metrics.candidate_execution_duration_ms += 1;
    let mut changed_reason = cal_run.clone();
    changed_reason.checks[0].reason = Some("different redacted diagnostic".to_string());

    for tampered_run in [
        changed_plan,
        changed_check,
        changed_execution,
        changed_metrics,
        changed_reason,
    ] {
        let error = persist_calibration_run(&mut db.conn, &tampered_run).unwrap_err();
        assert!(error.contains("conflict"), "unexpected error: {error}");
    }
}
