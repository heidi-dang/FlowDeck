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
fn test_verification_output_bounds_truncates_large_output_and_marks_incomplete() {
    let dir = tempdir().unwrap();
    let pkg_json = dir.path().join("package.json");
    let pkg_val = serde_json::json!({
        "name": "flood-pkg",
        "packageManager": "npm@10.0.0",
        "scripts": {
            "test": "node -e \"process.stdout.write('X'.repeat(50000))\""
        }
    });
    std::fs::write(&pkg_json, pkg_val.to_string()).unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "check:pkg:npm:.:test".to_string(),
            display_name: "flood-pkg test".to_string(),
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
            timeout: Duration::from_secs(10),
            max_stdout_bytes: 4096,
            max_stderr_bytes: 4096,
            tail_limit_bytes: 1024,
        },
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Incomplete);
    assert_eq!(run.assurance, AssuranceLevel::Unverified);
    assert_eq!(run.checks.len(), 1);
    let check_res = &run.checks[0];
    assert_eq!(check_res.status, CheckExecutionStatus::OutputLimitExceeded);
    assert!(check_res.stdout_truncated);
    assert!(check_res.stdout_digest.is_some());
    assert!(check_res.stdout_captured_bytes >= 4096);
    assert!(check_res
        .reason
        .as_ref()
        .unwrap()
        .contains("output exceeded maximum byte cap"));
    if let Some(ref excerpt) = check_res.stdout_excerpt {
        assert!(excerpt.len() <= 1024);
    }
}
