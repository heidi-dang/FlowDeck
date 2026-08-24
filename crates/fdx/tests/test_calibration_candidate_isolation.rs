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
fn test_candidate_plan_is_preserved_exact_and_unchanged() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    let candidate_check = PlannedCheck {
        check_id: "test:npm:packages/core/tests/a.test.ts".to_string(),
        display_name: "packages/core/tests/a.test.ts".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:packages/core".to_string(),
        reason: "direct test for change".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };

    let candidate_plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![candidate_check.clone()],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let source_run = VerificationRun {
        run_id: "run-cand-iso-1".to_string(),
        plan: candidate_plan.clone(),
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: candidate_check.check_id.clone(),
            kind: candidate_check.kind,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_1".to_string(),
            reused_execution: false,
            command: vec!["npm".to_string(), "test".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 25,
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
        duration_ms: 25,
    };

    let policy = CalibrationPolicy::default();
    let cal_run = run_calibration(repo_root, &source_run, &policy).unwrap();

    // 1. Candidate plan inside calibration result must be byte-for-byte identical to source plan
    assert_eq!(cal_run.candidate_plan, candidate_plan);
    assert_eq!(cal_run.candidate_plan.selected_checks.len(), 1);
    assert_eq!(
        cal_run.candidate_plan.selected_checks[0].check_id,
        candidate_check.check_id
    );

    // 2. Candidate check is present in shadow reference checks and marked candidate_selected = true
    let found_cand = cal_run
        .checks
        .iter()
        .find(|c| c.check_id == candidate_check.check_id)
        .unwrap();
    assert!(found_cand.candidate_selected);
    assert!(found_cand.reference_selected);
}
