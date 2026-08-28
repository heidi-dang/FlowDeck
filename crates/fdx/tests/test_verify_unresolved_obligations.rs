use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, UnresolvedVerificationObligation, VerificationCheckKind,
    VerificationPlan,
};
use fdx::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_unresolved_obligations_with_zero_checks_is_incomplete() {
    let dir = tempdir().unwrap();
    let plan = VerificationPlan {
        assurance: AssuranceLevel::Unverified,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![],
        uncertainty: vec![],
        unresolved_obligations: vec![UnresolvedVerificationObligation {
            scope: "pkg:npm:unresolved".to_string(),
            reason: "discovery limit exceeded".to_string(),
            source: "discovery_limit".to_string(),
        }],
    };

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Incomplete);
    assert_eq!(run.assurance, AssuranceLevel::Unverified);
}

#[test]
fn test_unresolved_obligations_with_passing_checks_is_incomplete() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "pass-pkg",
        "packageManager": "npm@10.0.0", "scripts": {"test": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Conservative,
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
        unresolved_obligations: vec![UnresolvedVerificationObligation {
            scope: "pkg:npm:other".to_string(),
            reason: "missing test suite for affected files".to_string(),
            source: "unsupported_config".to_string(),
        }],
    };

    let options = VerificationExecutorOptions {
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.checks.len(), 1);
    assert_eq!(run.checks[0].status, CheckExecutionStatus::Passed);
    assert_eq!(run.outcome, VerificationOutcome::Incomplete);
    assert_eq!(run.assurance, AssuranceLevel::Unverified);
}
