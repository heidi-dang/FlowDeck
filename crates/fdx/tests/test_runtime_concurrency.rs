use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_run;
use fdx::intelligence::testplan::model::VerificationPlan;
use fdx::intelligence::verify::model::{VerificationOutcome, VerificationRun};
use fdx::protocol::AssuranceLevel;
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

#[test]
fn test_runtime_concurrent_same_run_ingestion() {
    let dir = tempdir().unwrap();
    let db = Arc::new(Mutex::new(
        EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap(),
    ));

    let run = VerificationRun {
        run_id: "run_conc_1".to_string(),
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

    let mut handles = Vec::new();
    for _ in 0..8 {
        let db_clone = Arc::clone(&db);
        let run_clone = run.clone();
        handles.push(std::thread::spawn(move || {
            let mut guard = db_clone.lock().unwrap();
            ingest_verification_run(&mut guard.conn, &run_clone, None)
        }));
    }

    let mut imported = 0;
    let mut already = 0;
    for h in handles {
        let res = h.join().unwrap().unwrap();
        match res {
            fdx::intelligence::runtime::model::RuntimeIngestResult::Imported { .. } => {
                imported += 1
            }
            fdx::intelligence::runtime::model::RuntimeIngestResult::AlreadyImported { .. } => {
                already += 1
            }
            _ => panic!("unexpected outcome: {:?}", res),
        }
    }

    assert_eq!(imported, 1);
    assert_eq!(already, 7);
}
