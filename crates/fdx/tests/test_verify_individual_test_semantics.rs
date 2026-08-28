use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::VerificationOutcome;
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_unknown_runner_does_not_falsely_pass_individual_test_file() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    // Package script is arbitrary exit(0) without proven runner capability
    std::fs::write(
        &pkg_json,
        r#"{"name": "custom-runner-pkg", "packageManager": "npm@10.0.0", "scripts": {"test": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
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
        }],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Passed);
    assert_eq!(run.checks.len(), 1);
    let check_res = &run.checks[0];
    // Must NOT execute as "npm run test -- tests/unit.test.ts"
    // Instead it must execute the rolled-up package suite: "npm run test"
    assert_eq!(check_res.command, vec!["npm", "run", "test"]);
}

#[test]
fn test_known_vitest_runner_targets_individual_file() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "vitest-pkg", "packageManager": "npm@10.0.0", "scripts": {"test": "vitest run"}}"#,
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
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
        }],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.checks.len(), 1);
    let check_res = &run.checks[0];
    assert!(check_res
        .command
        .contains(&"tests/unit.test.ts".to_string()));
}
