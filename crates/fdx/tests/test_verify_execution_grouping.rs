use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::VerificationOutcome;
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_suite_rollup_multiple_obligations_share_single_execution_id() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    let counter_file = dir.path().join("counter.txt");

    let script = format!(
        "node -e \"require('fs').appendFileSync('{p}', 'X'); process.exit(0);\"",
        p = counter_file.display()
    );

    std::fs::write(
        &pkg_json,
        serde_json::to_string(&serde_json::json!({
            "name": "rollup-group-pkg",
            "packageManager": "npm@10.0.0",
            "scripts": {
                "test": script
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![
            PlannedCheck {
                check_id: "test:npm:tests/a.test.js".to_string(),
                display_name: "a test".to_string(),
                kind: VerificationCheckKind::UnitTest,
                scope: "pkg:npm:.".to_string(),
                reason: "evidence".to_string(),
                selection: SelectionReason::Evidence,
                strength: EvidenceStrength::Precise,
                evidence_path: None,
                evidence_refs: vec![],
                widening_reason: None,
                mandatory: true,
            },
            PlannedCheck {
                check_id: "test:npm:tests/b.test.js".to_string(),
                display_name: "b test".to_string(),
                kind: VerificationCheckKind::UnitTest,
                scope: "pkg:npm:.".to_string(),
                reason: "evidence".to_string(),
                selection: SelectionReason::Evidence,
                strength: EvidenceStrength::Precise,
                evidence_path: None,
                evidence_refs: vec![],
                widening_reason: None,
                mandatory: true,
            },
            PlannedCheck {
                check_id: "test:npm:tests/c.test.js".to_string(),
                display_name: "c test".to_string(),
                kind: VerificationCheckKind::UnitTest,
                scope: "pkg:npm:.".to_string(),
                reason: "evidence".to_string(),
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

    let first_exec_id = &run.checks[0].execution_id;
    assert!(!first_exec_id.is_empty());
    assert!(!run.checks[0].reused_execution);

    // Checks 1 and 2 must share the exact same execution_id and be marked reused_execution: true
    assert_eq!(&run.checks[1].execution_id, first_exec_id);
    assert!(run.checks[1].reused_execution);

    assert_eq!(&run.checks[2].execution_id, first_exec_id);
    assert!(run.checks[2].reused_execution);

    // Process was actually executed exactly ONCE
    let counter_content = std::fs::read_to_string(&counter_file).unwrap();
    assert_eq!(
        counter_content, "X",
        "process ran multiple times instead of single execution rollup"
    );
}
