//! Tests for predicate runtime_history qualification and generator metadata validation.

use fdx::intelligence::attestation::build_verification_attestation;
use fdx::intelligence::attestation::canonical::canonicalize_to_vec;
use fdx::intelligence::attestation::verify::verify_attestation;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::runtime::sha256_bytes;
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

fn setup_test_run(run_id: &str) -> (tempfile::TempDir, VerificationRun) {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();

    let check = CheckExecutionResult {
        check_id: "check:test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        status: CheckExecutionStatus::Passed,
        execution_id: "exec:1".to_string(),
        reused_execution: false,
        command: vec!["cargo".to_string(), "test".to_string()],
        cwd: ".".to_string(),
        exit_code: Some(0),
        signal: None,
        duration_ms: 15,
        stdout_digest: Some("sha256:abc".to_string()),
        stderr_digest: Some("sha256:def".to_string()),
        stdout_excerpt: None,
        stderr_excerpt: None,
        stdout_captured_bytes: 10,
        stderr_captured_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        started_at_ms: 1000,
        reason: None,
    };

    let planned = PlannedCheck {
        check_id: "check:test".to_string(),
        display_name: "check:test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "workspace:root".to_string(),
        reason: "changed".to_string(),
        selection: SelectionReason::Evidence,
        strength: fdx::protocol::EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    };

    let run = VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![planned],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![check],
        uncertainty: vec![],
        base: Some("main".to_string()),
        head: Some("HEAD".to_string()),
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 20,
    };

    persist_verification_run(repo_root, &run).unwrap();

    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    let artifact_path = repo_root
        .join(".fdx")
        .join("runs")
        .join(format!("{}.json", run_id));
    let raw_bytes = std::fs::read(&artifact_path).unwrap();
    ingest_verification_artifact(&mut db.conn, &raw_bytes).unwrap();

    (tmp, run)
}

#[test]
fn test_predicate_run_contract_version_tamper_rejected() {
    let (tmp, run) = setup_test_run("run-contract-tamper");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let mut attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    // 1. Tamper predicate contract version to 1 (legacy)
    attestation.predicate.runtime_history.run_contract_version = 1;
    let canonical = canonicalize_to_vec(&attestation).unwrap();
    let sha = sha256_bytes(&canonical);
    let res1 = verify_attestation(
        repo_root,
        &attestation,
        Some(&canonical),
        Some(&sha),
        &db.conn,
    );
    assert!(
        res1.is_err(),
        "Predicate run_contract_version = 1 must be rejected"
    );

    // 2. Tamper predicate contract version to 3 (future)
    attestation.predicate.runtime_history.run_contract_version = 3;
    let canonical = canonicalize_to_vec(&attestation).unwrap();
    let sha = sha256_bytes(&canonical);
    let res2 = verify_attestation(
        repo_root,
        &attestation,
        Some(&canonical),
        Some(&sha),
        &db.conn,
    );
    assert!(
        res2.is_err(),
        "Predicate run_contract_version = 3 must be rejected"
    );
}

#[test]
fn test_predicate_run_qualified_false_rejected() {
    let (tmp, run) = setup_test_run("run-qualified-tamper");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let mut attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    // Tamper run_qualified to false
    attestation.predicate.runtime_history.run_qualified = false;
    let canonical = canonicalize_to_vec(&attestation).unwrap();
    let sha = sha256_bytes(&canonical);
    let res = verify_attestation(
        repo_root,
        &attestation,
        Some(&canonical),
        Some(&sha),
        &db.conn,
    );
    assert!(
        res.is_err(),
        "Predicate run_qualified = false must be rejected"
    );
}

#[test]
fn test_generator_tamper_rejected() {
    let (tmp, run) = setup_test_run("run-gen-tamper");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let mut attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    // Tamper generator name to claim false 3rd-party signer
    attestation.predicate.generator.name = "trusted-third-party".to_string();
    let canonical = canonicalize_to_vec(&attestation).unwrap();
    let sha = sha256_bytes(&canonical);
    let res = verify_attestation(
        repo_root,
        &attestation,
        Some(&canonical),
        Some(&sha),
        &db.conn,
    );
    assert!(res.is_err(), "Generator name != 'fdx' must be rejected");

    // Tamper generator version to empty
    attestation.predicate.generator.name = "fdx".to_string();
    attestation.predicate.generator.version = "".to_string();
    let canonical = canonicalize_to_vec(&attestation).unwrap();
    let sha = sha256_bytes(&canonical);
    let res2 = verify_attestation(
        repo_root,
        &attestation,
        Some(&canonical),
        Some(&sha),
        &db.conn,
    );
    assert!(res2.is_err(), "Empty generator version must be rejected");
}

#[test]
fn test_historical_snapshot_unaffected_by_current_db_change() {
    let (tmp, run) = setup_test_run("run-history-snap");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    // Verify valid originally
    let canonical = canonicalize_to_vec(&attestation).unwrap();
    let sha = sha256_bytes(&canonical);
    assert!(verify_attestation(
        repo_root,
        &attestation,
        Some(&canonical),
        Some(&sha),
        &db.conn
    )
    .is_ok());

    // Invert runtime_ingestion_state in current DB
    db.conn.execute("INSERT OR REPLACE INTO runtime_ingestion_state (key, value) VALUES ('is_complete', 'false')", []).unwrap();

    // Old attestation must STILL verify successfully because global_history_complete_at_generation is a historical observation
    assert!(verify_attestation(
        repo_root,
        &attestation,
        Some(&canonical),
        Some(&sha),
        &db.conn
    )
    .is_ok());
}
