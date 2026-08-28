//! Tests for bounded file reading and non-regular file rejection.

use fdx::intelligence::attestation::persist::{
    load_attestation_from_path, MAX_ATTESTATION_ARTIFACT_BYTES,
};
use std::fs::File;
use tempfile::tempdir;

#[test]
fn test_directory_as_attestation_path_rejected() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();

    let res = load_attestation_from_path(
        repo_root,
        repo_root,
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
    );
    assert!(res.is_err());
    let err = res.unwrap_err();
    assert!(
        err.contains("not a regular file") || err.contains("directory") || err.contains("invalid")
    );
}

#[test]
fn test_oversized_attestation_rejected_before_full_read() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    let big_file = repo_root.join("oversized.json");

    // Create a file exceeding MAX_ATTESTATION_ARTIFACT_BYTES
    let f = File::create(&big_file).unwrap();
    f.set_len(MAX_ATTESTATION_ARTIFACT_BYTES + 1).unwrap();

    let res = load_attestation_from_path(
        repo_root,
        &big_file,
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
    );
    assert!(res.is_err());
    let err = res.unwrap_err();
    assert!(
        err.contains("exceeds maximum allowed size")
            || err.contains("oversized")
            || err.contains("too large")
    );
}
