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
use std::time::Instant;
use tempfile::tempdir;

#[test]
fn blocking_shadow_process_receives_only_remaining_total_budget() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let package = root.join("packages/core");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("package.json"),
        r#"{
          "name": "core",
          "packageManager": "npm@10.0.0",
          "scripts": {
            "test": "node -e \"process.exit(0)\"",
            "test:unit": "node -e \"setTimeout(() => {}, 10000)\""
          }
        }"#,
    )
    .unwrap();

    let candidate = PlannedCheck {
        check_id: "check:pkg:npm:packages/core:test".to_string(),
        display_name: "test".to_string(),
        kind: VerificationCheckKind::Custom,
        scope: "pkg:npm:packages/core".to_string(),
        reason: "selected".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };
    let source = VerificationRun {
        run_id: "strict-budget-source".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![candidate.clone()],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: candidate.check_id.clone(),
            kind: candidate.kind,
            status: CheckExecutionStatus::Passed,
            execution_id: "test-source-exec".to_string(),
            reused_execution: false,
            command: vec!["node".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 1,
            stdout_digest: None,
            stderr_digest: None,
            stdout_excerpt: None,
            stderr_excerpt: None,
            stdout_captured_bytes: 0,
            stderr_captured_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            started_at_ms: 1,
            reason: None,
        }],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1,
        duration_ms: 1,
    };
    let policy = CalibrationPolicy {
        max_shadow_checks: 10,
        max_total_duration_ms: 250,
        per_check_timeout_ms: 10_000,
        ..Default::default()
    };

    let started = Instant::now();
    let calibration = run_calibration(root, &source, &policy).unwrap();
    assert!(
        started.elapsed().as_millis() < 3_000,
        "shadow execution ignored total budget"
    );
    assert!(
        calibration.duration_ms < 3_000,
        "recorded duration ignored total budget"
    );
    assert_eq!(calibration.status, CalibrationStatus::Incomplete);
    assert!(calibration.checks.iter().any(|check| {
        check.check_id == "check:pkg:npm:packages/core:test:unit"
            && check.signal_class == SignalClass::Incomplete
    }));
}
