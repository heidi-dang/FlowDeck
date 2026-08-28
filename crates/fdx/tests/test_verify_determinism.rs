use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_verification_determinism_and_deduplication() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "determ-pkg",
        "packageManager": "npm@10.0.0", "scripts": {"test_a": "node -e 'process.exit(0)'", "test_b": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

    let check_a = PlannedCheck {
        check_id: "check:pkg:npm:.:test_a".to_string(),
        display_name: "test a".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:.".to_string(),
        reason: "check a".to_string(),
        selection: SelectionReason::MandatoryCheck,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    };
    let check_b = PlannedCheck {
        check_id: "check:pkg:npm:.:test_b".to_string(),
        display_name: "test b".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:.".to_string(),
        reason: "check b".to_string(),
        selection: SelectionReason::MandatoryCheck,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    };

    // Include duplicate check_a
    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![check_a.clone(), check_b.clone(), check_a.clone()],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    // Must execute only 2 unique checks
    assert_eq!(run.checks.len(), 2);
    assert_eq!(run.checks[0].check_id, "check:pkg:npm:.:test_a");
    assert_eq!(run.checks[1].check_id, "check:pkg:npm:.:test_b");
}
