use fdx::intelligence::testplan::model::VerificationPlan;
use fdx::intelligence::verify::model::{PersistenceStatus, VerificationOutcome};
use fdx::intelligence::verify::persist::load_verification_run;
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_persisted_artifact_equals_returned_run_including_status() {
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

    let returned_run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(returned_run.outcome, VerificationOutcome::Passed);
    assert!(matches!(
        returned_run.persistence_status,
        PersistenceStatus::Persisted { .. }
    ));

    // Load persisted artifact from disk
    let loaded_run = load_verification_run(dir.path(), &returned_run.run_id).unwrap();

    // Invariant: returned run must strictly equal persisted artifact across all fields
    assert_eq!(returned_run.run_id, loaded_run.run_id);
    assert_eq!(returned_run.plan, loaded_run.plan);
    assert_eq!(returned_run.outcome, loaded_run.outcome);
    assert_eq!(returned_run.assurance, loaded_run.assurance);
    assert_eq!(returned_run.checks, loaded_run.checks);
    assert_eq!(returned_run.uncertainty, loaded_run.uncertainty);
    assert_eq!(returned_run.base, loaded_run.base);
    assert_eq!(returned_run.head, loaded_run.head);
    assert_eq!(
        returned_run.persistence_status,
        loaded_run.persistence_status
    );
    assert_eq!(returned_run.executed_at_ms, loaded_run.executed_at_ms);
    assert_eq!(returned_run.duration_ms, loaded_run.duration_ms);
    assert_eq!(returned_run, loaded_run);
}
