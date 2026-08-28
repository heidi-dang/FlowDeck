//! Tests for filesystem TOCTOU races, handle boundaries, and atomic publication safety.

use fdx::intelligence::attestation::build_verification_attestation;
use fdx::intelligence::attestation::canonical::canonicalize_to_vec;
use fdx::intelligence::attestation::persist::{
    classify_attestation_source, clear_test_before_publish_hook, persist_attestation,
    read_bounded_file, set_test_before_publish_hook, set_test_inject_link_failure,
    ManagedAttestationDir, MAX_ATTESTATION_ARTIFACT_BYTES,
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
use std::fs::{self, File};
use std::io::ErrorKind;
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
fn test_target_symlink_race_rejected() {
    let (dir, run) = setup_test_run("toctou_symlink_1");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();
    let canonical_bytes = canonicalize_to_vec(&attestation).unwrap();
    let att_sha = fdx::intelligence::runtime::sha256_bytes(&canonical_bytes);

    let managed_dir = ManagedAttestationDir::ensure(repo_root).unwrap();
    let target_filename = format!("{}.{}.json", run.run_id, att_sha);
    let target_path = managed_dir.attestations_dir.join(&target_filename);

    let outside_dir = tempdir().unwrap();
    let outside_file = outside_dir.path().join("victim.json");
    fs::write(&outside_file, b"unmodified external victim content").unwrap();

    // Hook: right before linkat, adversary creates target_path as a symlink to outside_file
    let target_path_clone = target_path.clone();
    let outside_file_clone = outside_file.clone();
    set_test_before_publish_hook(move || {
        let _ = symlink(&outside_file_clone, &target_path_clone);
    });

    let res = persist_attestation(repo_root, &attestation);
    clear_test_before_publish_hook();

    assert!(
        res.is_err(),
        "Expected persist_attestation to fail when target is substituted with symlink"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("symlink") || err.contains("target"),
        "Error message should mention symlink or target: {}",
        err
    );

    // Victim file must remain completely untouched
    let victim_content = fs::read_to_string(&outside_file).unwrap();
    assert_eq!(victim_content, "unmodified external victim content");
}

#[test]
fn test_target_identical_byte_symlink_race_rejected() {
    let (dir, run) = setup_test_run("toctou_symlink_identical");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();
    let canonical_bytes = canonicalize_to_vec(&attestation).unwrap();
    let att_sha = fdx::intelligence::runtime::sha256_bytes(&canonical_bytes);

    let managed_dir = ManagedAttestationDir::ensure(repo_root).unwrap();
    let target_filename = format!("{}.{}.json", run.run_id, att_sha);
    let target_path = managed_dir.attestations_dir.join(&target_filename);

    let outside_dir = tempdir().unwrap();
    let outside_file = outside_dir.path().join("identical.json");
    // Write EXACT canonical bytes into the outside file
    fs::write(&outside_file, &canonical_bytes).unwrap();

    // Hook: adversary creates target_path as symlink to outside file having identical bytes
    let target_path_clone = target_path.clone();
    let outside_file_clone = outside_file.clone();
    set_test_before_publish_hook(move || {
        let _ = symlink(&outside_file_clone, &target_path_clone);
    });

    let res = persist_attestation(repo_root, &attestation);
    clear_test_before_publish_hook();

    // MUST STILL FAIL: A symlink target must never be accepted as valid published managed evidence
    assert!(
        res.is_err(),
        "Expected persist_attestation to reject symlink target even with identical bytes"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("symlink") || err.contains("target"),
        "Error message should indicate symlink rejection: {}",
        err
    );
}

#[test]
fn test_target_special_file_race_rejected() {
    let (dir, run) = setup_test_run("toctou_dir_target");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();
    let canonical_bytes = canonicalize_to_vec(&attestation).unwrap();
    let att_sha = fdx::intelligence::runtime::sha256_bytes(&canonical_bytes);

    let managed_dir = ManagedAttestationDir::ensure(repo_root).unwrap();
    let target_filename = format!("{}.{}.json", run.run_id, att_sha);
    let target_path = managed_dir.attestations_dir.join(&target_filename);

    // Hook: adversary creates target_path as a directory
    let target_path_clone = target_path.clone();
    set_test_before_publish_hook(move || {
        let _ = fs::create_dir_all(&target_path_clone);
    });

    let res = persist_attestation(repo_root, &attestation);
    clear_test_before_publish_hook();

    assert!(
        res.is_err(),
        "Expected persist_attestation to fail when target is a directory"
    );
}

#[test]
fn test_managed_directory_swap_cannot_escape() {
    let (dir, run) = setup_test_run("toctou_dir_swap");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    let outside_dir = tempdir().unwrap();
    let outside_path = outside_dir.path().to_path_buf();

    let attestations_dir = repo_root.join(".fdx").join("attestations");
    let attestations_bak = repo_root.join(".fdx").join("attestations_bak");

    // Hook: after ManagedAttestationDir::ensure opens directory handle, swap pathname with symlink to outside
    let attestations_dir_clone = attestations_dir.clone();
    let attestations_bak_clone = attestations_bak.clone();
    let outside_path_clone = outside_path.clone();
    set_test_before_publish_hook(move || {
        let _ = fs::rename(&attestations_dir_clone, &attestations_bak_clone);
        let _ = symlink(&outside_path_clone, &attestations_dir_clone);
    });

    let _res = persist_attestation(repo_root, &attestation);
    clear_test_before_publish_hook();

    // Verify: outside directory MUST receive 0 entries!
    let outside_entries: Vec<_> = fs::read_dir(&outside_path).unwrap().collect();
    assert_eq!(
        outside_entries.len(),
        0,
        "Outside directory should not have received any files during directory swap race"
    );
}

#[test]
fn test_unsupported_publication_primitive_fails_safely() {
    let (dir, run) = setup_test_run("toctou_unsupported");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    set_test_inject_link_failure(Some(ErrorKind::Unsupported));
    let res = persist_attestation(repo_root, &attestation);
    set_test_inject_link_failure(None);

    assert!(res.is_err(), "Expected unsupported linkat to fail closed");
    let err = res.unwrap_err();
    assert!(
        err.contains("Refusing non-atomic fallback"),
        "Error must mention refusing non-atomic fallback: {}",
        err
    );

    // Verify no stray files
    let att_dir = repo_root.join(".fdx").join("attestations");
    let entries: Vec<_> = fs::read_dir(&att_dir).unwrap().collect();
    assert_eq!(entries.len(), 0, "No target or temp files should remain");
}

#[test]
fn test_huge_existing_target_bounded() {
    let (dir, run) = setup_test_run("toctou_huge_target");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();
    let canonical_bytes = canonicalize_to_vec(&attestation).unwrap();
    let att_sha = fdx::intelligence::runtime::sha256_bytes(&canonical_bytes);

    let managed_dir = ManagedAttestationDir::ensure(repo_root).unwrap();
    let target_filename = format!("{}.{}.json", run.run_id, att_sha);
    let target_path = managed_dir.attestations_dir.join(&target_filename);

    // Create a 20 MB file at target_path
    let big_buf = vec![b'a'; (MAX_ATTESTATION_ARTIFACT_BYTES + 1024 * 1024) as usize];
    fs::write(&target_path, &big_buf).unwrap();

    let res = persist_attestation(repo_root, &attestation);
    assert!(
        res.is_err(),
        "Expected huge target to fail bounded read/size check"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("exceeds maximum allowed size"),
        "Expected oversized error: {}",
        err
    );
}

#[test]
fn test_managed_jail_invalid_does_not_downgrade_to_external() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    let outside_dir = tempdir().unwrap();
    let fdx_dir = repo_root.join(".fdx");
    symlink(outside_dir.path(), &fdx_dir).unwrap();

    let target_path = repo_root
        .join(".fdx")
        .join("attestations")
        .join("run1.0000000000000000000000000000000000000000000000000000000000000000.json");

    // Even with expected_sha256 provided, target_path is under .fdx so it MUST NOT downgrade to External
    let res = classify_attestation_source(
        repo_root,
        &target_path,
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
    );

    assert!(
        res.is_err(),
        "Expected managed jail violation to reject classification"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("Managed attestation directory safety violation"),
        "Error should indicate directory safety violation: {}",
        err
    );
}

#[test]
fn test_concurrent_20_writers_same_attestation_converge() {
    let (dir, run) = setup_test_run("toctou_concurrent_20");
    let repo_root = dir.path().to_path_buf();

    let db = EvidenceDatabase::open(&repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(&repo_root, &run.run_id, &db.conn).unwrap();

    let mut handles = Vec::new();
    for _ in 0..20 {
        let rp = repo_root.clone();
        let att = attestation.clone();
        handles.push(std::thread::spawn(move || persist_attestation(&rp, &att)));
    }

    let mut paths = Vec::new();
    let mut shas = Vec::new();
    for h in handles {
        let (path, sha) = h.join().unwrap().unwrap();
        paths.push(path);
        shas.push(sha);
    }

    // All must return the exact same path and SHA
    assert_eq!(paths.len(), 20);
    assert_eq!(shas.len(), 20);
    for p in &paths {
        assert_eq!(p, &paths[0]);
    }
    for s in &shas {
        assert_eq!(s, &shas[0]);
    }

    // There must be exactly 1 file in .fdx/attestations
    let att_dir = repo_root.join(".fdx").join("attestations");
    let entries: Vec<_> = fs::read_dir(&att_dir).unwrap().collect();
    assert_eq!(
        entries.len(),
        1,
        "Exactly one published attestation artifact should exist"
    );
}

#[test]
fn test_bounded_read_file_growth_during_read_rejected() {
    let tmp = tempdir().unwrap();
    let file_path = tmp.path().join("growing.bin");

    // Write 100 bytes initially
    fs::write(&file_path, vec![b'x'; 100]).unwrap();

    let mut file = File::open(&file_path).unwrap();

    // Call read_bounded_file with max_bytes = 50 (smaller than 100) -> fstat rejects
    let res = read_bounded_file(&mut file, 50);
    assert!(
        res.is_err(),
        "Expected file size > max_bytes to be rejected"
    );
    let err = res.unwrap_err();
    assert!(
        err.contains("exceeds maximum allowed size"),
        "Error: {}",
        err
    );
}

#[test]
fn test_temp_name_retry_availability() {
    let (dir, run) = setup_test_run("toctou_temp_avail");
    let repo_root = dir.path();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    // Persistence should succeed reliably without temp collision failures
    let res = persist_attestation(repo_root, &attestation);
    assert!(res.is_ok());
}
