use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::engine::run_incremental_index;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use tempfile::tempdir;

#[test]
#[cfg(unix)]
fn test_failed_refresh_rollback_unix_perms() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    fs::create_dir_all(repo_root.join("src")).unwrap();
    fs::write(repo_root.join("src/a.ts"), "const a = 1;").unwrap();

    // First successful index
    run_incremental_index(repo_root, false).unwrap();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let gen_before: u64 = db
        .get_metadata("generation")
        .unwrap()
        .unwrap()
        .parse()
        .unwrap();
    let files_before: i64 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .unwrap();
    assert_eq!(files_before, 1);
    drop(db); // Release DB before making directory unreadable

    // Create an unreadable directory to cause a traversal error
    let unreadable = repo_root.join("unreadable");
    fs::create_dir(&unreadable).unwrap();
    let mut perms = fs::metadata(&unreadable).unwrap().permissions();
    perms.set_mode(0o000); // Remove all permissions
    fs::set_permissions(&unreadable, perms).unwrap();

    // Try to run refresh again -> Should fail due to traversal error
    let result = run_incremental_index(repo_root, true);
    println!("RESULT IS: {:?}", result);
    assert!(result.is_err(), "Expected error due to traversal failure");

    // Restore permissions so cleanup doesn't fail
    let mut perms = fs::metadata(&unreadable).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&unreadable, perms).unwrap();

    let db2 = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let gen_after: u64 = db2
        .get_metadata("generation")
        .unwrap()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        gen_before, gen_after,
        "Generation should not advance on failed refresh"
    );

    let files_after: i64 = db2
        .conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .unwrap();
    assert_eq!(files_after, 1, "Files should remain untouched");

    // Status should be DEGRADED
    let status = db2.get_metadata("status").unwrap().unwrap();
    assert_eq!(status, "DEGRADED");

    // Last error should be recorded
    let last_error = db2.get_metadata("last_error").unwrap().unwrap();
    assert!(last_error.contains("Traversal errors"));
}

#[test]
fn test_failed_refresh_rollback_neutral() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    std::fs::create_dir_all(repo_root.join("src")).unwrap();
    std::fs::write(repo_root.join("src/a.ts"), "const a = 1;").unwrap();

    // First successful index
    run_incremental_index(repo_root, false).unwrap();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let gen_before: u64 = db
        .get_metadata("generation")
        .unwrap()
        .unwrap()
        .parse()
        .unwrap();
    let files_before: i64 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .unwrap();
    assert_eq!(files_before, 1);
    drop(db);

    // Inject error
    std::env::set_var("FDX_INJECT_TRAVERSAL_ERROR", "1");
    let result = run_incremental_index(repo_root, true);
    std::env::remove_var("FDX_INJECT_TRAVERSAL_ERROR");

    assert!(result.is_err(), "Expected error due to traversal failure");

    let db2 = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let gen_after: u64 = db2
        .get_metadata("generation")
        .unwrap()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        gen_before, gen_after,
        "Generation should not advance on failed refresh"
    );

    let files_after: i64 = db2
        .conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .unwrap();
    assert_eq!(files_after, 1, "Files should remain untouched");

    let status = db2.get_metadata("status").unwrap().unwrap();
    assert_eq!(status, "DEGRADED");

    let last_error = db2.get_metadata("last_error").unwrap().unwrap();
    assert!(last_error.contains("Traversal errors"));
}
