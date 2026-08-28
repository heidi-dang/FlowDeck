//! Tests for safe handle-based directory descent during attestation handle acquisition.

use fdx::intelligence::attestation::build_verification_attestation;
use fdx::intelligence::attestation::persist::{
    clear_test_before_acquire_attestations_hook, clear_test_before_acquire_fdx_hook,
    persist_attestation, set_test_before_acquire_attestations_hook,
    set_test_before_acquire_fdx_hook, ManagedAttestationDir,
};
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
use std::fs;
use std::os::unix::fs::symlink;
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
        .join(format!("{}.json", run.run_id));
    let raw_bytes = fs::read(&artifact_path).unwrap();
    ingest_verification_artifact(&mut db.conn, &raw_bytes).unwrap();

    (tmp, run)
}

#[test]
fn test_managed_directory_swap_during_acquisition() {
    let (dir, run) = setup_test_run("acq_att_swap");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    let outside_dir = tempdir().unwrap();
    let outside_path = outside_dir.path().to_path_buf();

    let attestations_dir = repo_root.join(".fdx").join("attestations");

    // Hook: right before openat("attestations"), adversary replaces .fdx/attestations with a symlink to outside
    let attestations_dir_clone = attestations_dir.clone();
    let outside_path_clone = outside_path.clone();
    set_test_before_acquire_attestations_hook(move || {
        let _ = fs::remove_dir_all(&attestations_dir_clone);
        let _ = symlink(&outside_path_clone, &attestations_dir_clone);
    });

    let res = persist_attestation(repo_root, &attestation);
    clear_test_before_acquire_attestations_hook();

    assert!(
        res.is_err(),
        "Expected persist_attestation to fail when attestations dir is swapped to symlink during acquisition"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("symlink"),
        "Error message should mention symlink: {}",
        err
    );

    // Verify outside directory received 0 files
    let entries: Vec<_> = fs::read_dir(&outside_path).unwrap().collect();
    assert_eq!(
        entries.len(),
        0,
        "Outside directory must receive zero files during acquisition swap race"
    );
}

#[test]
fn test_fdx_directory_swap_during_acquisition() {
    let (dir, run) = setup_test_run("acq_fdx_swap");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    let outside_dir = tempdir().unwrap();
    let outside_path = outside_dir.path().to_path_buf();

    let fdx_dir = repo_root.join(".fdx");

    // Hook: right before openat(".fdx"), adversary replaces .fdx with a symlink to outside
    let fdx_dir_clone = fdx_dir.clone();
    let outside_path_clone = outside_path.clone();
    set_test_before_acquire_fdx_hook(move || {
        let _ = fs::remove_dir_all(&fdx_dir_clone);
        let _ = symlink(&outside_path_clone, &fdx_dir_clone);
    });

    let res = persist_attestation(repo_root, &attestation);
    clear_test_before_acquire_fdx_hook();

    assert!(
        res.is_err(),
        "Expected persist_attestation to fail when .fdx dir is swapped to symlink during acquisition"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("symlink"),
        "Error message should mention symlink: {}",
        err
    );

    // Verify outside directory received 0 files
    let entries: Vec<_> = fs::read_dir(&outside_path).unwrap().collect();
    assert_eq!(
        entries.len(),
        0,
        "Outside directory must receive zero files during .fdx acquisition swap race"
    );
}

#[test]
fn test_managed_dir_ensure_descriptor_relative() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();

    // Ensure creates .fdx and .fdx/attestations safely
    let managed = ManagedAttestationDir::ensure(repo_root).unwrap();
    assert_eq!(managed.repo_root, repo_root.canonicalize().unwrap());
    assert_eq!(
        managed.fdx_dir,
        repo_root.canonicalize().unwrap().join(".fdx")
    );
    assert_eq!(
        managed.attestations_dir,
        repo_root
            .canonicalize()
            .unwrap()
            .join(".fdx")
            .join("attestations")
    );
}
