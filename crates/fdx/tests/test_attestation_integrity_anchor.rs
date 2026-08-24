//! Tests for filename integrity anchors and external expected-digest verification.

use fdx::intelligence::attestation::build_verification_attestation;
use fdx::intelligence::attestation::persist::{load_attestation_from_path, persist_attestation};
use fdx::intelligence::attestation::verify::verify_attestation;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
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
fn test_managed_filename_integrity_anchor() {
    let (tmp, run) = setup_test_run("run-filename-anchor");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    let (path, att_sha) = persist_attestation(repo_root, &attestation).unwrap();

    // 1. Loading valid managed path succeeds
    let (loaded_att, raw_bytes, loaded_sha) =
        load_attestation_from_path(repo_root, &path, None).unwrap();
    assert_eq!(loaded_sha, att_sha);
    assert!(verify_attestation(repo_root, &loaded_att, Some(&raw_bytes), None, &db.conn).is_ok());

    // 2. Corrupt filename digest fails
    let bad_filename = path.parent().unwrap().join(format!(
        "{}.0000000000000000000000000000000000000000000000000000000000000000.json",
        run.run_id
    ));
    std::fs::copy(&path, &bad_filename).unwrap();
    let load_err = load_attestation_from_path(repo_root, &bad_filename, None);
    assert!(load_err.is_err());
    assert!(load_err.unwrap_err().contains("Filename digest mismatch"));
}

#[test]
fn test_external_file_integrity_anchor_contract() {
    let (tmp, run) = setup_test_run("run-external-anchor");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    let (path, att_sha) = persist_attestation(repo_root, &attestation).unwrap();
    let external_path = repo_root.join("external_statement.json");
    std::fs::copy(&path, &external_path).unwrap();

    // 1. Loading external non-content-addressed file without expected SHA fails closed
    let load_err = load_attestation_from_path(repo_root, &external_path, None);
    assert!(load_err.is_err());
    assert!(load_err.unwrap_err().contains("requires --expected-sha256"));

    // 2. Loading with wrong expected SHA fails
    let wrong_sha = "0000000000000000000000000000000000000000000000000000000000000000";
    let load_wrong = load_attestation_from_path(repo_root, &external_path, Some(wrong_sha));
    assert!(load_wrong.is_err());
    assert!(load_wrong.unwrap_err().contains("Expected digest mismatch"));

    // 3. Loading with correct expected SHA succeeds and verifies
    let (loaded_att, raw_bytes, _) =
        load_attestation_from_path(repo_root, &external_path, Some(&att_sha)).unwrap();
    let verify_res = verify_attestation(
        repo_root,
        &loaded_att,
        Some(&raw_bytes),
        Some(&att_sha),
        &db.conn,
    );
    assert!(verify_res.is_ok());
}
