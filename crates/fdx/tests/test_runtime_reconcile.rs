use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::{list_historical_runs, reconcile_runs_directory};
use fdx::intelligence::testplan::model::VerificationPlan;
use fdx::intelligence::verify::model::{VerificationOutcome, VerificationRun};
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_runtime_reconcile_discovers_and_imports_runs() {
    let dir = tempdir().unwrap();
    let runs_dir = dir.path().join(".fdx").join("runs");
    std::fs::create_dir_all(&runs_dir).unwrap();

    let run = VerificationRun {
        run_id: "run_reconcile_1".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: fdx::intelligence::verify::model::PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10,
    };

    let run_file = runs_dir.join("run_reconcile_1.json");
    std::fs::write(&run_file, serde_json::to_string(&run).unwrap()).unwrap();

    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();
    let rep = reconcile_runs_directory(&mut db.conn, dir.path()).unwrap();

    assert_eq!(rep.artifacts_discovered, 1);
    assert_eq!(rep.artifacts_imported, 1);
    assert!(rep.is_complete);

    let runs = list_historical_runs(&db.conn, 10).unwrap();
    assert_eq!(runs.len(), 1);
}
