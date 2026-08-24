//! Tests for single-open, no-follow handling of external attestation files.

use fdx::intelligence::attestation::build_verification_attestation;
use fdx::intelligence::attestation::canonical::canonicalize_to_vec;
use fdx::intelligence::attestation::persist::{
    clear_test_before_open_external_hook, load_attestation_from_path,
    set_test_before_open_external_hook,
};
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
fn test_external_regular_to_symlink_before_open() {
    let (dir, run) = setup_test_run("ext_symlink_open");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();
    let canonical_bytes = canonicalize_to_vec(&attestation).unwrap();
    let att_sha = sha256_bytes(&canonical_bytes);

    let ext_dir = tempdir().unwrap();
    let ext_file = ext_dir.path().join("external_attestation.json");
    fs::write(&ext_file, &canonical_bytes).unwrap();

    let other_file = ext_dir.path().join("other.json");
    fs::write(&other_file, b"something else").unwrap();

    // Hook: right before opening the external file, adversary replaces ext_file with a symlink to other_file
    let ext_file_clone = ext_file.clone();
    let other_file_clone = other_file.clone();
    set_test_before_open_external_hook(move || {
        let _ = fs::remove_file(&ext_file_clone);
        let _ = symlink(&other_file_clone, &ext_file_clone);
    });

    let res = load_attestation_from_path(repo_root, &ext_file, Some(&att_sha));
    clear_test_before_open_external_hook();

    assert!(
        res.is_err(),
        "Expected loading external attestation to fail when substituted with symlink before open"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("symlink"),
        "Error should mention symlink rejection: {}",
        err
    );
}

#[test]
fn test_external_same_byte_symlink_substitution() {
    let (dir, run) = setup_test_run("ext_same_byte_symlink");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();
    let canonical_bytes = canonicalize_to_vec(&attestation).unwrap();
    let att_sha = sha256_bytes(&canonical_bytes);

    let ext_dir = tempdir().unwrap();
    let ext_file = ext_dir.path().join("external_attestation.json");
    fs::write(&ext_file, &canonical_bytes).unwrap();

    let other_file = ext_dir.path().join("other_identical.json");
    // Other file has EXACT same canonical bytes
    fs::write(&other_file, &canonical_bytes).unwrap();

    // Hook: adversary replaces ext_file with a symlink to other_file before open
    let ext_file_clone = ext_file.clone();
    let other_file_clone = other_file.clone();
    set_test_before_open_external_hook(move || {
        let _ = fs::remove_file(&ext_file_clone);
        let _ = symlink(&other_file_clone, &ext_file_clone);
    });

    let res = load_attestation_from_path(repo_root, &ext_file, Some(&att_sha));
    clear_test_before_open_external_hook();

    // MUST FAIL: symlinks are strictly rejected even if target has identical bytes!
    assert!(
        res.is_err(),
        "Expected loading external attestation to reject symlink even with identical bytes"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("symlink"),
        "Error should mention symlink rejection: {}",
        err
    );
}

#[test]
fn test_external_different_file_substitution() {
    let (dir, run) = setup_test_run("ext_diff_file");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();
    let canonical_bytes = canonicalize_to_vec(&attestation).unwrap();
    let att_sha = sha256_bytes(&canonical_bytes);

    let ext_dir = tempdir().unwrap();
    let ext_file = ext_dir.path().join("external_attestation.json");
    fs::write(&ext_file, &canonical_bytes).unwrap();

    // Hook: adversary replaces ext_file with another regular file having different content
    let ext_file_clone = ext_file.clone();
    set_test_before_open_external_hook(move || {
        let _ = fs::write(&ext_file_clone, br#"{"tampered": true}"#);
    });

    let res = load_attestation_from_path(repo_root, &ext_file, Some(&att_sha));
    clear_test_before_open_external_hook();

    assert!(
        res.is_err(),
        "Expected loading external attestation to fail SHA digest check on different file content"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("digest mismatch") || err.contains("Expected digest mismatch"),
        "Error should mention digest mismatch: {}",
        err
    );
}

#[test]
fn test_external_valid_passes_with_expected_sha() {
    let (dir, run) = setup_test_run("ext_valid");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();
    let canonical_bytes = canonicalize_to_vec(&attestation).unwrap();
    let att_sha = sha256_bytes(&canonical_bytes);

    let ext_dir = tempdir().unwrap();
    let ext_file = ext_dir.path().join("external_attestation.json");
    fs::write(&ext_file, &canonical_bytes).unwrap();

    let res = load_attestation_from_path(repo_root, &ext_file, Some(&att_sha));
    assert!(
        res.is_ok(),
        "Expected valid external attestation to succeed"
    );
    let (loaded_att, loaded_bytes, loaded_sha) = res.unwrap();
    assert_eq!(loaded_sha, att_sha);
    assert_eq!(loaded_bytes, canonical_bytes);
    assert_eq!(loaded_att.predicate.run.run_id, run.run_id);
}
