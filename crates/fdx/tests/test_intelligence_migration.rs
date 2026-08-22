use fdx::intelligence::db::{DatabaseError, DatabaseOpenMode, EvidenceDatabase};
use tempfile::tempdir;

#[test]
fn test_synthetic_migration() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let fdx_dir = repo_root.join(".fdx");
    std::fs::create_dir_all(&fdx_dir).unwrap();
    let db_path = fdx_dir.join("index.sqlite");

    // Create v0 schema
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.pragma_update(None, "user_version", 0).unwrap();
        // A minimal v0 table to prove it existed before migration
        conn.execute("CREATE TABLE v0_legacy (id INTEGER PRIMARY KEY)", [])
            .unwrap();
    }

    // Open ReadWrite -> should migrate 0 to 1
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    assert_eq!(db.get_schema_version().unwrap().version, 1);

    // Legacy table should still exist
    let count: i32 = db
        .conn
        .query_row("SELECT count(*) FROM v0_legacy", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);

    // Metadata table from v1 should exist
    let count2: i32 = db
        .conn
        .query_row("SELECT count(*) FROM metadata", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count2, 0);
}

#[test]
fn test_future_schema_rejected_after_migration_setup() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let fdx_dir = repo_root.join(".fdx");
    std::fs::create_dir_all(&fdx_dir).unwrap();
    let db_path = fdx_dir.join("index.sqlite");

    // Create future schema
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.pragma_update(None, "user_version", 999).unwrap();
    }

    let result = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite);
    match result {
        Err(DatabaseError::FutureSchemaVersion(999)) => {}
        _ => panic!("Expected FutureSchemaVersion(999) error"),
    }
}
