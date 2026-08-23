use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_verify_npm_package_and_test_file() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "npm-pkg", "scripts": {"test": "node -e 'process.exit(0)'", "typecheck": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![
            PlannedCheck {
                check_id: "check:pkg:npm:.:typecheck".to_string(),
                display_name: "typecheck".to_string(),
                kind: VerificationCheckKind::Typecheck,
                scope: "pkg:npm:.".to_string(),
                reason: "changed".to_string(),
                selection: SelectionReason::MandatoryCheck,
                strength: EvidenceStrength::Precise,
                evidence_path: None,
                evidence_refs: vec![],
                widening_reason: None,
                mandatory: true,
            },
            PlannedCheck {
                check_id: "test:npm:tests/unit.test.ts".to_string(),
                display_name: "unit test".to_string(),
                kind: VerificationCheckKind::UnitTest,
                scope: "pkg:npm:.".to_string(),
                reason: "direct impact".to_string(),
                selection: SelectionReason::Evidence,
                strength: EvidenceStrength::Precise,
                evidence_path: None,
                evidence_refs: vec![],
                widening_reason: None,
                mandatory: true,
            },
        ],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Passed);
    assert_eq!(run.checks.len(), 2);
    assert_eq!(run.checks[0].status, CheckExecutionStatus::Passed);
    assert_eq!(run.checks[1].status, CheckExecutionStatus::Passed);
}
