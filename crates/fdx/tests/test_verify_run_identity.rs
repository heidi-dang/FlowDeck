use fdx::intelligence::testplan::model::VerificationPlan;
use fdx::intelligence::verify::identity::generate_unique_run_id;
use fdx::intelligence::verify::model::VerificationOutcome;
use fdx::intelligence::verify::persist::load_verification_run;
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::AssuranceLevel;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::thread;
use tempfile::tempdir;

#[test]
fn test_run_id_unique_for_same_plan_and_same_timestamp() {
    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let fixed_timestamp = 1720000000000;
    let mut ids = HashSet::new();
    for _ in 0..100 {
        let run_id = generate_unique_run_id(&plan, Some(fixed_timestamp));
        assert!(
            ids.insert(run_id),
            "collision detected under identical timestamp and plan"
        );
    }
    assert_eq!(ids.len(), 100);
}

#[test]
fn test_concurrent_identical_runs_produce_unique_artifacts_without_overwriting() {
    let dir = Arc::new(tempdir().unwrap());
    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let thread_count = 64;
    let mut handles = Vec::new();
    let runs = Arc::new(Mutex::new(Vec::new()));

    for _ in 0..thread_count {
        let dir_clone = Arc::clone(&dir);
        let plan_clone = plan.clone();
        let runs_clone = Arc::clone(&runs);

        handles.push(thread::spawn(move || {
            let options = VerificationExecutorOptions {
                persist: true,
                ..Default::default()
            };
            let run = execute_verification_plan(dir_clone.path(), &plan_clone, &options).unwrap();
            assert_eq!(run.outcome, VerificationOutcome::Passed);
            runs_clone.lock().unwrap().push(run);
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    let all_runs = runs.lock().unwrap();
    assert_eq!(all_runs.len(), thread_count);

    let mut run_ids = HashSet::new();
    for run in all_runs.iter() {
        assert!(
            run_ids.insert(&run.run_id),
            "duplicate run_id in concurrent executions"
        );
        // Verify each artifact is present and readable on disk
        let loaded = load_verification_run(dir.path(), &run.run_id).unwrap();
        assert_eq!(loaded.run_id, run.run_id);
    }
    assert_eq!(run_ids.len(), thread_count);
}
