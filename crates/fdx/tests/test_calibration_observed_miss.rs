use fdx::intelligence::calibration::model::{CalibrationPolicy, SignalClass};
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
fn test_unselected_failing_check_is_classified_as_observed_shadow_miss() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    // Create a package with two checks/scripts in package.json
    let core_dir = repo_root.join("packages").join("core");
    std::fs::create_dir_all(core_dir.join("tests")).unwrap();
    std::fs::write(
        core_dir.join("package.json"),
        r#"{"name": "core", "scripts": {"test": "echo passed", "check-fail": "false"}}"#,
    )
    .unwrap();
    std::fs::write(
        core_dir.join("tests").join("passing.test.ts"),
        "test('ok', () => {});",
    )
    .unwrap();

    // Candidate selected only the passing test
    let selected_check = PlannedCheck {
        check_id: "test:npm:packages/core/tests/passing.test.ts".to_string(),
        display_name: "packages/core/tests/passing.test.ts".to_string(),
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
        run_id: "run-miss-1".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![selected_check.clone()],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: selected_check.check_id.clone(),
            kind: selected_check.kind,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_1".to_string(),
            reused_execution: false,
            command: vec!["echo".to_string(), "passed".to_string()],
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

    let passing_obs = cal_run
        .checks
        .iter()
        .find(|c| c.check_id == selected_check.check_id)
        .unwrap();
    assert_eq!(passing_obs.signal_class, SignalClass::SelectedPass);
    assert!(!passing_obs.is_observed_shadow_miss);
}
