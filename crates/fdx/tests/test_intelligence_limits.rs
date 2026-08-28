use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::engine::run_incremental_index;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_resource_limit_skips() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    fs::create_dir_all(repo_root.join("src")).unwrap();

    // We can test by injecting a file larger than MAX_FILE_BYTES, but MAX is 10MB.
    // Let's create a 11MB file to trigger the limit.
    let large_data = vec![0u8; 11 * 1024 * 1024];
    fs::write(repo_root.join("src/large.bin"), &large_data).unwrap();

    let report = run_incremental_index(repo_root, false).unwrap();
    assert_eq!(report.state.to_string(), "degraded");
    assert_eq!(report.skipped, 1);

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let status = db.get_metadata("status").unwrap().unwrap();
    assert_eq!(status, "DEGRADED");

    let last_error = db.get_metadata("last_error").unwrap().unwrap();
    assert!(last_error.contains("file_too_large"), "got: {}", last_error);
}
