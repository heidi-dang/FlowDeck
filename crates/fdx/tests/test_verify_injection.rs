use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_verification_injection_safely_passes_arguments_without_shell() {
    let dir = tempdir().unwrap();
    // Test that script names with shell metacharacters are treated as literal arguments, not shell commands
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "inject-pkg", "scripts": {"test": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

    let injected_check = PlannedCheck {
        check_id: "check:pkg:npm:.; touch INJECTED.txt:test".to_string(),
        display_name: "injection test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:.".to_string(),
        reason: "injection attempt".to_string(),
        selection: SelectionReason::MandatoryCheck,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    };

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![injected_check],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let _ = execute_verification_plan(dir.path(), &plan, &options);
    // Assert the injected file was NEVER created
    assert!(!dir.path().join("INJECTED.txt").exists());
}
