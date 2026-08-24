use fdx::intelligence::calibration::model::{CalibrationPolicy, ReferenceScope};
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
fn test_shadow_reference_is_superset_of_candidate_plan() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    // Setup package.json in packages/core
    let core_dir = repo_root.join("packages").join("core");
    std::fs::create_dir_all(core_dir.join("tests")).unwrap();
    std::fs::write(
        core_dir.join("package.json"),
        r#"{"name": "core", "scripts": {"test": "echo test_ok"}}"#,
    )
    .unwrap();
    std::fs::write(
        core_dir.join("tests").join("a.test.ts"),
        "test('a', () => {});",
    )
    .unwrap();
    std::fs::write(
        core_dir.join("tests").join("b.test.ts"),
        "test('b', () => {});",
    )
    .unwrap();

    let candidate_check = PlannedCheck {
        check_id: "test:npm:packages/core/tests/a.test.ts".to_string(),
        display_name: "packages/core/tests/a.test.ts".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:packages/core".to_string(),
        reason: "direct test".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };

    let source_run = VerificationRun {
        run_id: "run-shadow-exec-1".to_string(),
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
            command: vec!["echo".to_string(), "test_ok".to_string()],
            cwd: "packages/core".to_string(),
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
        max_shadow_checks: 50,
        max_total_duration_ms: 60_000,
        per_check_timeout_ms: 10_000,
        max_output_bytes: 16 * 1024 * 1024,
    };

    let cal_run = run_calibration(repo_root, &source_run, &policy).unwrap();

    // The reference set must contain candidate check 'a.test.ts' AND discovered check 'b.test.ts'
    assert!(cal_run
        .checks
        .iter()
        .any(|c| c.check_id == candidate_check.check_id && c.candidate_selected));
    assert!(cal_run
        .checks
        .iter()
        .any(|c| c.check_id.contains("b.test.ts") && !c.candidate_selected));
    assert!(cal_run.metrics.shadow_reference_count >= 2);
}
