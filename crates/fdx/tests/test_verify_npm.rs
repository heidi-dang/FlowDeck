use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_verify_npm_package_and_test_file_suite_rollup() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "npm-pkg",
        "packageManager": "npm@10.0.0", "scripts": {"test": "node -e 'process.exit(0)'", "typecheck": "node -e 'process.exit(0)'"}}"#,
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
    assert_eq!(run.checks[0].command, vec!["npm", "run", "typecheck"]);
    assert_eq!(run.checks[1].status, CheckExecutionStatus::Passed);
    assert_eq!(run.checks[1].command, vec!["npm", "run", "test"]);
}

#[test]
fn test_verify_npm_known_runner_individual_targeting() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "npm-vitest-pkg",
        "packageManager": "npm@10.0.0", "scripts": {"test": "vitest run"}}"#,
    )
    .unwrap();
    std::fs::write(dir.path().join("vitest.config.ts"), "export default {};").unwrap();

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
    assert_eq!(
        run.checks[0].command,
        vec!["npm", "run", "test", "--", "tests/unit.test.ts"]
    );
}

#[test]
fn test_verify_npm_unknown_runner_without_test_script_is_unsupported() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "no-test-script-pkg",
        "packageManager": "npm@10.0.0", "scripts": {"build": "node -e 'process.exit(0)'"}}"#,
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
    assert_eq!(run.outcome, VerificationOutcome::Incomplete);
    assert_eq!(run.assurance, AssuranceLevel::Unverified);
    assert_eq!(run.checks[0].status, CheckExecutionStatus::Unsupported);
}
