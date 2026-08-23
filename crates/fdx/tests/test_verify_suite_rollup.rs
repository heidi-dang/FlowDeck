use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::VerificationOutcome;
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_suite_rollup_executes_package_suite_once_for_multiple_individual_tests() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    let counter_path = dir.path().join("counter.txt");
    let script = format!(
        "node -e \"const fs = require('fs'); const n = fs.existsSync('{p}') ? parseInt(fs.readFileSync('{p}', 'utf8')) + 1 : 1; fs.writeFileSync('{p}', String(n)); process.exit(0);\"",
        p = counter_path.display()
    );

    let pkg_val = serde_json::json!({
        "name": "rollup-pkg",
        "scripts": {
            "test": script
        }
    });
    std::fs::write(&pkg_json, pkg_val.to_string()).unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![
            PlannedCheck {
                check_id: "test:npm:tests/a.test.ts".to_string(),
                display_name: "test a".to_string(),
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
            PlannedCheck {
                check_id: "test:npm:tests/b.test.ts".to_string(),
                display_name: "test b".to_string(),
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
            PlannedCheck {
                check_id: "test:npm:tests/c.test.ts".to_string(),
                display_name: "test c".to_string(),
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
    assert_eq!(run.checks.len(), 3);

    // Verify counter file contains 1, proving single execution
    let count_str = std::fs::read_to_string(&counter_path).unwrap();
    assert_eq!(count_str.trim(), "1");
}
