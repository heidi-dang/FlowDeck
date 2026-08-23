use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use fdx::intelligence::verify::process::ProcessBounds;
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use std::time::Duration;
use tempfile::tempdir;

#[test]
fn test_verification_timeout_kills_child_and_marks_incomplete() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    std::fs::write(
        &pkg_json,
        r#"{"name": "sleep-pkg", "scripts": {"test": "node -e 'setTimeout(() => {}, 10000)'"}}"#,
    )
    .unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "check:pkg:npm:.:test".to_string(),
            display_name: "sleep-pkg test".to_string(),
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
        bounds: ProcessBounds {
            timeout: Duration::from_millis(300),
            max_stdout_bytes: 1024,
            max_stderr_bytes: 1024,
            tail_limit_bytes: 512,
        },
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Incomplete);
    assert_eq!(run.assurance, AssuranceLevel::Unverified);
    assert_eq!(run.checks.len(), 1);
    let check_res = &run.checks[0];
    assert_eq!(check_res.status, CheckExecutionStatus::TimedOut);
    assert!(check_res.duration_ms >= 250);
}
