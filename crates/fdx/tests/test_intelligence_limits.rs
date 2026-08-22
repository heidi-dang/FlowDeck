
use fdx::intelligence::db::{EvidenceDatabase, DatabaseOpenMode};
use fdx::intelligence::engine::run_incremental_index;
use tempfile::tempdir;
use std::fs;

#[test]
fn test_resource_limit_skips() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    fs::create_dir_all(repo_root.join("src")).unwrap();
    
    // We can test by injecting a file larger than MAX_FILE_BYTES, but MAX is 10MB.
    // Let's create a 11MB file to trigger the limit.
    let large_data = vec![0u8; 11 * 1024 * 1024];
    fs::write(repo_root.join("src/large.bin"), &large_data).unwrap();
    
    let result = run_incremental_index(repo_root, false);
    assert!(result.is_err(), "Expected error because a file was skipped");
    
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let status = db.get_metadata("status").unwrap().unwrap();
    assert_eq!(status, "DEGRADED");
    
    let last_error = db.get_metadata("last_error").unwrap().unwrap();
    assert!(last_error.contains("Skipped 1 files"));
    assert!(last_error.contains("file_too_large"));
}
