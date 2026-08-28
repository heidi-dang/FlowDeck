use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::{list_historical_runs, reconcile_runs_directory};
use fdx::intelligence::testplan::model::VerificationPlan;
use fdx::intelligence::verify::model::{VerificationOutcome, VerificationRun};
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_runtime_crash_window_recovery_via_reconciliation() {
    let dir = tempdir().unwrap();
    let runs_dir = dir.path().join(".fdx").join("runs");
    std::fs::create_dir_all(&runs_dir).unwrap();

    // Simulate crash window: 3 M7 artifacts saved on disk, but process crashed before SQLite insert
    for i in 1..=3 {
        let run = VerificationRun {
            run_id: format!("run_crashed_{}", i),
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
            executed_at_ms: 1000 + i,
            duration_ms: 10,
        };
        let file = runs_dir.join(format!("run_crashed_{}.json", i));
        std::fs::write(&file, serde_json::to_string(&run).unwrap()).unwrap();
    }

    // Reopen DB fresh and reconcile
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();
    let initial_runs = list_historical_runs(&db.conn, 10).unwrap();
    assert_eq!(initial_runs.len(), 0);

    let report = reconcile_runs_directory(&mut db.conn, dir.path()).unwrap();
    assert_eq!(report.artifacts_discovered, 3);
    assert_eq!(report.artifacts_imported, 3);
    assert!(report.is_complete);

    let recovered_runs = list_historical_runs(&db.conn, 10).unwrap();
    assert_eq!(recovered_runs.len(), 3);
}
