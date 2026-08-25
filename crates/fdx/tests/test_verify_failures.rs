use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_verification_failure_records_failed_status_and_exit_code() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "fail-pkg",
        "packageManager": "npm@10.0.0", "scripts": {"test": "node -e 'process.exit(42)'"}}"#,
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "check:pkg:npm:.:test".to_string(),
            display_name: "fail-pkg test".to_string(),
            kind: VerificationCheckKind::UnitTest,
            scope: "pkg:npm:.".to_string(),
            reason: "mandatory check".to_string(),
            selection: SelectionReason::MandatoryCheck,
            strength: EvidenceStrength::Precise,
            evidence_path: None,
            evidence_refs: vec![],
            widening_reason: None,
            mandatory: true,
        }],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Failed);
    assert_eq!(run.checks.len(), 1);
    let check_res = &run.checks[0];
    assert_eq!(check_res.status, CheckExecutionStatus::Failed);
    assert_eq!(check_res.exit_code, Some(42));
}
