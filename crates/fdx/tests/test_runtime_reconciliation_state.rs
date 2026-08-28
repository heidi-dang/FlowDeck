use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::reconcile_runs_directory;
use fdx::intelligence::testplan::model::VerificationPlan;
use fdx::intelligence::verify::model::{VerificationOutcome, VerificationRun};
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_reconciliation_completeness_state_persists_across_reopen() {
    let dir = tempdir().unwrap();
    let runs_dir = dir.path().join(".fdx").join("runs");
    std::fs::create_dir_all(&runs_dir).unwrap();

    // 1. Create a malformed artifact
    let malformed_file = runs_dir.join("malformed.json");
    std::fs::write(&malformed_file, "{ not valid json").unwrap();

    {
        let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();
        let rep = reconcile_runs_directory(&mut db.conn, dir.path()).unwrap();
        assert!(
            !rep.is_complete,
            "reconciliation must be incomplete with malformed artifact"
        );
        assert_eq!(rep.artifacts_failed, 1);
    }

    // 2. Reopen DB and check that completeness is durably false
    {
        let db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadOnly).unwrap();
        let is_complete: String = db
            .conn
            .query_row(
                "SELECT value FROM runtime_ingestion_state WHERE key = 'is_complete'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_complete, "false");
    }

    // 3. Fix the malformed artifact and re-reconcile
    std::fs::remove_file(&malformed_file).unwrap();
    let run = VerificationRun {
        run_id: "valid_run".to_string(),
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
    std::fs::write(
        runs_dir.join("valid_run.json"),
        serde_json::to_string(&run).unwrap(),
    )
    .unwrap();

    {
        let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();
        let rep = reconcile_runs_directory(&mut db.conn, dir.path()).unwrap();
        assert!(rep.is_complete, "reconciliation must now be complete");
        assert_eq!(rep.artifacts_imported, 1);
    }

    // 4. Reopen and verify durably true
    {
        let db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadOnly).unwrap();
        let is_complete: String = db
            .conn
            .query_row(
                "SELECT value FROM runtime_ingestion_state WHERE key = 'is_complete'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_complete, "true");
    }
}
