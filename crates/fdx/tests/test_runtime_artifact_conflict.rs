use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::model::RuntimeIngestResult;
use fdx::intelligence::runtime::{ingest_verification_artifact, list_historical_runs};
use fdx::intelligence::testplan::model::VerificationPlan;
use fdx::intelligence::verify::model::{VerificationOutcome, VerificationRun};
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_runtime_divergent_artifact_same_run_id_returns_conflict() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run1 = VerificationRun {
        run_id: "run_conflict_1".to_string(),
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

    let mut run2 = run1.clone();
    run2.duration_ms = 999; // Mutated content changes artifact digest

    let bytes1 = serde_json::to_vec(&run1).unwrap();
    let bytes2 = serde_json::to_vec(&run2).unwrap();

    let res1 = ingest_verification_artifact(&mut db.conn, &bytes1).unwrap();
    assert!(matches!(res1, RuntimeIngestResult::Imported { .. }));

    let res2 = ingest_verification_artifact(&mut db.conn, &bytes2).unwrap();
    assert!(matches!(res2, RuntimeIngestResult::Conflict { .. }));

    let runs = list_historical_runs(&db.conn, 10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].duration_ms, 10); // Original remains unchanged
}
