use fdx::intelligence::calibration::model::CalibrationPolicy;
use fdx::intelligence::calibration::run_calibration;
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
fn test_zero_failing_signals_results_in_null_signal_recall() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    let check = PlannedCheck {
        check_id: "test:npm:packages/core/tests/pass.test.ts".to_string(),
        display_name: "packages/core/tests/pass.test.ts".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:packages/core".to_string(),
        reason: "passing".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };

    let source_run = VerificationRun {
        run_id: "run-zero-sig-1".to_string(),
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
            execution_id: "exec_pass".to_string(),
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

    assert_eq!(cal_run.metrics.selected_failure_count, 0);
    assert_eq!(cal_run.metrics.unselected_failure_count, 0);
    // signal_recall MUST be None (never 1.0 or 100% when no failing signal existed)
    assert!(cal_run.metrics.signal_recall.is_none());
}
