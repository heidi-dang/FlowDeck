use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::digest::sha256_bytes;
use fdx::intelligence::runtime::get_historical_run;
use fdx::intelligence::testplan::model::VerificationPlan;
use fdx::intelligence::verify::executor::{execute_verification_plan, VerificationExecutorOptions};
use fdx::intelligence::verify::model::VerificationOutcome;
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_post_verify_exact_persisted_artifact_ingestion() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    // Create a minimal package.json
    std::fs::write(
        repo_root.join("package.json"),
        r#"{"name":"test-pkg","packageManager":"npm@10.0.0","scripts":{"test":"node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();

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

    let run = execute_verification_plan(repo_root, &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Passed);

    let artifact_path = repo_root
        .join(".fdx")
        .join("runs")
        .join(format!("{}.json", run.run_id));
    assert!(artifact_path.exists());

    let raw_bytes = std::fs::read(&artifact_path).unwrap();
    let expected_file_sha = sha256_bytes(&raw_bytes);

    // Ingest into history database
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    let ingest_res =
        fdx::intelligence::runtime::ingest_verification_artifact(&mut db.conn, &raw_bytes).unwrap();
    assert!(matches!(
        ingest_res,
        fdx::intelligence::runtime::model::RuntimeIngestResult::Imported { .. }
    ));

    // Verify stored digest in SQLite matches exact file sha256
    let (run_obs, _, _) = get_historical_run(&db.conn, &run.run_id).unwrap().unwrap();
    assert_eq!(run_obs.artifact_digest, expected_file_sha);
}
