use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_persistence_failure_marks_run_incomplete_and_unverified() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "pass-pkg", "packageManager": "npm@10.0.0", "scripts": {"test": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "check:pkg:npm:.:test".to_string(),
            display_name: "pass test".to_string(),
            kind: VerificationCheckKind::UnitTest,
            scope: "pkg:npm:.".to_string(),
            reason: "changed".to_string(),
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

    // Pre-create .fdx/runs as a regular file so directory creation fails
    let fdx_dir = dir.path().join(".fdx");
    std::fs::create_dir_all(&fdx_dir).unwrap();
    std::fs::write(fdx_dir.join("runs"), "not a directory").unwrap();

    let options = VerificationExecutorOptions {
        persist: true,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    // Checks themselves passed
    assert_eq!(run.checks.len(), 1);
    assert_eq!(run.checks[0].status, CheckExecutionStatus::Passed);

    // Persistence failed -> run outcome is Incomplete, assurance Unverified
    assert!(matches!(
        run.persistence_status,
        PersistenceStatus::Failed { .. }
    ));
    assert_eq!(run.outcome, VerificationOutcome::Incomplete);
    assert_eq!(run.assurance, AssuranceLevel::Unverified);
}
