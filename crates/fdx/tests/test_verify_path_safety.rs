use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_verification_path_safety_rejects_parent_escape() {
    let dir = tempdir().unwrap();
    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "check:pkg:npm:../../outside:test".to_string(),
            display_name: "escaped test".to_string(),
            kind: VerificationCheckKind::UnitTest,
            scope: "pkg:npm:../../outside".to_string(),
            reason: "malicious scope".to_string(),
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
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Incomplete);
    assert_eq!(run.checks.len(), 1);
    let check_res = &run.checks[0];
    assert_eq!(check_res.status, CheckExecutionStatus::Unsupported);
    assert!(check_res
        .reason
        .as_ref()
        .unwrap()
        .contains("escapes repository root"));
}
