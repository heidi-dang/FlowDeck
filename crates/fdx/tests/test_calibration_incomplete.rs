use fdx::intelligence::calibration::model::{CalibrationPolicy, CalibrationStatus, SignalClass};
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
fn test_unselected_check_timeout_or_failure_to_spawn_remains_incomplete() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    let check = PlannedCheck {
        check_id: "check:pkg:npm:packages/unknown:test".to_string(),
        display_name: "packages/unknown:test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:packages/unknown".to_string(),
        reason: "unknown".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };

    let source_run = VerificationRun {
        run_id: "run-inc-1".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![check.clone()],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Incomplete,
        assurance: AssuranceLevel::Unverified,
        checks: vec![CheckExecutionResult {
            check_id: check.check_id.clone(),
            kind: check.kind,
            status: CheckExecutionStatus::TimedOut,
            execution_id: "exec_timeout".to_string(),
            reused_execution: false,
            command: vec![],
            cwd: ".".to_string(),
            exit_code: None,
            signal: None,
            duration_ms: 10000,
            stdout_digest: None,
            stderr_digest: None,
            stdout_excerpt: None,
            stderr_excerpt: None,
            stdout_captured_bytes: 0,
            stderr_captured_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            started_at_ms: 1000,
            reason: Some("timed out".to_string()),
        }],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10000,
    };

    let policy = CalibrationPolicy::default();
    let cal_run = run_calibration(repo_root, &source_run, &policy).unwrap();

    assert_eq!(cal_run.status, CalibrationStatus::Incomplete);
    assert_eq!(cal_run.metrics.shadow_incomplete_count, 1);
    assert_eq!(cal_run.checks[0].signal_class, SignalClass::Incomplete);
    assert!(!cal_run.checks[0].is_observed_shadow_miss);
    assert!(!cal_run.metrics.eligibility.eligible_for_miss_rate);
}
