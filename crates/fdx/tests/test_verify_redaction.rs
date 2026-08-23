use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::persist::load_verification_run;
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_verification_redaction_before_persistence() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    let pkg_val = serde_json::json!({
        "name": "secret-pkg",
        "scripts": {
            "test": "node -e \"console.log('SECRET: OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz and Bearer supersecrettokenhere123')\""
        }
    });
    std::fs::write(&pkg_json, pkg_val.to_string()).unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "check:pkg:npm:.:test".to_string(),
            display_name: "secret-pkg test".to_string(),
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
        persist: true,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.checks.len(), 1);
    let check_res = &run.checks[0];
    let excerpt = check_res.stdout_excerpt.as_ref().unwrap();
    assert!(!excerpt.contains("1234567890abcdefghijklmnopqrstuvwxyz"));
    assert!(!excerpt.contains("supersecrettokenhere123"));
    assert!(excerpt.contains("[REDACTED]"));

    // Check persisted JSON file
    let loaded = load_verification_run(dir.path(), &run.run_id).unwrap();
    let persisted_excerpt = loaded.checks[0].stdout_excerpt.as_ref().unwrap();
    assert!(!persisted_excerpt.contains("1234567890abcdefghijklmnopqrstuvwxyz"));
    assert!(!persisted_excerpt.contains("supersecrettokenhere123"));
}
