use fdx::intelligence::calibration::model::{CalibrationPolicy, CalibrationStatus, ReferenceScope};
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
fn test_max_shadow_checks_limit_truncates_and_marks_incomplete() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    // Create 10 test files in repo
    let core_dir = repo_root.join("packages").join("core").join("tests");
    std::fs::create_dir_all(&core_dir).unwrap();
    for i in 0..10 {
        std::fs::write(
            core_dir.join(format!("test_{}.test.ts", i)),
            "test('ok', () => {});",
        )
        .unwrap();
    }
    std::fs::write(
        repo_root.join("packages").join("core").join("package.json"),
        r#"{"name": "core", "scripts": {"test": "echo ok"}}"#,
    )
    .unwrap();

    let candidate_check = PlannedCheck {
        check_id: "test:npm:packages/core/tests/test_0.test.ts".to_string(),
        display_name: "packages/core/tests/test_0.test.ts".to_string(),
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
        run_id: "run-lim-1".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![candidate_check.clone()],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: candidate_check.check_id.clone(),
            kind: candidate_check.kind,
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

    let policy = CalibrationPolicy {
        scope: ReferenceScope::AffectedPackage,
        max_shadow_checks: 3, // Cap at 3
        max_total_duration_ms: 60_000,
        per_check_timeout_ms: 10_000,
        max_output_bytes: 16 * 1024 * 1024,
    };

    let cal_run = run_calibration(repo_root, &source_run, &policy).unwrap();

    assert_eq!(cal_run.checks.len(), 3);
    assert!(cal_run.reference_truncated);
    assert_eq!(cal_run.status, CalibrationStatus::Incomplete);
    assert!(!cal_run.metrics.eligibility.eligible_for_miss_rate);
}
