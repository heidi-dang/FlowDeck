use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::runtime::model::RuntimeIngestResult;
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use std::sync::{Arc, Barrier};
use tempfile::tempdir;

fn sample_run(run_id: &str, suffix: &str) -> VerificationRun {
    VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![PlannedCheck {
                check_id: format!("check:{}", suffix),
                display_name: format!("check:{}", suffix),
                kind: VerificationCheckKind::UnitTest,
                scope: "pkg:npm:.".to_string(),
                reason: "changed".to_string(),
                selection: SelectionReason::Evidence,
                strength: EvidenceStrength::Precise,
                evidence_path: None,
                evidence_refs: vec![],
                widening_reason: None,
                mandatory: true,
            }],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: format!("check:{}", suffix),
            kind: VerificationCheckKind::UnitTest,
            status: CheckExecutionStatus::Passed,
            execution_id: format!("exec_{}", suffix),
            reused_execution: false,
            command: vec!["npm".to_string(), "test".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 10,
            stdout_digest: None,
            stderr_digest: None,
            stdout_excerpt: None,
            stderr_excerpt: None,
            stdout_captured_bytes: 0,
            stderr_captured_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            started_at_ms: 1000,
            reason: None,
        }],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10,
    }
}

#[test]
fn test_real_multi_connection_concurrent_same_artifact() {
    let dir = tempdir().unwrap();
    let repo_path = dir.path().to_path_buf();

    // Initialize the DB first
    {
        let _init_db = EvidenceDatabase::open(&repo_path, DatabaseOpenMode::ReadWrite).unwrap();
    }

    let run = sample_run("run_conc_same", "same");
    let raw_bytes = Arc::new(serde_json::to_vec(&run).unwrap());
    let thread_count = 8;
    let barrier = Arc::new(Barrier::new(thread_count));

    let mut handles = Vec::new();
    for _ in 0..thread_count {
        let repo_clone = repo_path.clone();
        let bytes_clone = Arc::clone(&raw_bytes);
        let bar_clone = Arc::clone(&barrier);

        handles.push(std::thread::spawn(move || {
            let mut db = EvidenceDatabase::open(&repo_clone, DatabaseOpenMode::ReadWrite).unwrap();
            bar_clone.wait();
            ingest_verification_artifact(&mut db.conn, &bytes_clone)
        }));
    }

    let mut imported = 0;
    let mut already = 0;
    for h in handles {
        let res = h.join().unwrap().unwrap();
        match res {
            RuntimeIngestResult::Imported { .. } => imported += 1,
            RuntimeIngestResult::AlreadyImported { .. } => already += 1,
            other => panic!("unexpected result: {:?}", other),
        }
    }

    assert_eq!(imported, 1, "exactly one connection must import");
    assert_eq!(
        already,
        thread_count - 1,
        "all others must report AlreadyImported"
    );
}

#[test]
fn test_real_multi_connection_concurrent_divergent_artifacts() {
    let dir = tempdir().unwrap();
    let repo_path = dir.path().to_path_buf();

    // Initialize DB
    {
        let _init_db = EvidenceDatabase::open(&repo_path, DatabaseOpenMode::ReadWrite).unwrap();
    }

    let run_a = sample_run("run_conc_div", "ver_a");
    let run_b = sample_run("run_conc_div", "ver_b");
    let bytes_a = Arc::new(serde_json::to_vec(&run_a).unwrap());
    let bytes_b = Arc::new(serde_json::to_vec(&run_b).unwrap());

    assert_ne!(bytes_a.as_slice(), bytes_b.as_slice());

    let barrier = Arc::new(Barrier::new(2));

    let repo1 = repo_path.clone();
    let b1 = Arc::clone(&bytes_a);
    let bar1 = Arc::clone(&barrier);
    let h1 = std::thread::spawn(move || {
        let mut db = EvidenceDatabase::open(&repo1, DatabaseOpenMode::ReadWrite).unwrap();
        bar1.wait();
        ingest_verification_artifact(&mut db.conn, &b1)
    });

    let repo2 = repo_path.clone();
    let b2 = Arc::clone(&bytes_b);
    let bar2 = Arc::clone(&barrier);
    let h2 = std::thread::spawn(move || {
        let mut db = EvidenceDatabase::open(&repo2, DatabaseOpenMode::ReadWrite).unwrap();
        bar2.wait();
        ingest_verification_artifact(&mut db.conn, &b2)
    });

    let res1 = h1.join().unwrap().unwrap();
    let res2 = h2.join().unwrap().unwrap();

    let (imp, conf) = match (&res1, &res2) {
        (RuntimeIngestResult::Imported { .. }, RuntimeIngestResult::Conflict { .. }) => (1, 1),
        (RuntimeIngestResult::Conflict { .. }, RuntimeIngestResult::Imported { .. }) => (1, 1),
        _ => panic!(
            "expected 1 Imported and 1 Conflict, got {:?} and {:?}",
            res1, res2
        ),
    };

    assert_eq!(imp, 1);
    assert_eq!(conf, 1);
}
