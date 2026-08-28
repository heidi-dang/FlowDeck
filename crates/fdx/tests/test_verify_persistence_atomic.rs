use fdx::intelligence::testplan::model::VerificationPlan;
use fdx::intelligence::verify::model::VerificationOutcome;
use fdx::intelligence::verify::persist::{load_verification_run, runs_dir};
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_persistence_writes_atomically_and_can_be_loaded() {
    let dir = tempdir().unwrap();
    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        persist: true,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Passed);

    // Verify artifact file exists and matches loaded run
    let artifact_path = runs_dir(dir.path()).join(format!("{}.json", run.run_id));
    assert!(artifact_path.exists());

    let loaded = load_verification_run(dir.path(), &run.run_id).unwrap();
    assert_eq!(loaded.run_id, run.run_id);
    assert_eq!(loaded.outcome, run.outcome);

    // Path traversal in load_verification_run must fail
    assert!(load_verification_run(dir.path(), "../../escape").is_err());
    assert!(load_verification_run(dir.path(), "/etc/passwd").is_err());
    assert!(load_verification_run(dir.path(), "..\\escape").is_err());
}
