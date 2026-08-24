use fdx::intelligence::db::EvidenceDatabase;
use tempfile::tempdir;

#[test]
fn test_database_creation_and_schema() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let db_path = repo_root.join(".fdx").join("index.sqlite");

    // Test initialization
    let db = EvidenceDatabase::open(
        repo_root,
        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
    )
    .expect("Failed to open database");
    assert!(db_path.exists(), "Database file should be created");

    // Check schema version
    let version = db.get_schema_version().unwrap();
    assert_eq!(version.version, 10);

    // Reopen preserves state
    drop(db);
    let db2 = EvidenceDatabase::open(
        repo_root,
        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
    )
    .expect("Failed to reopen database");
    let version2 = db2.get_schema_version().unwrap();
    assert_eq!(version2.version, 10);
}

#[test]
fn test_future_schema_rejected() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    // Create DB directly and set version to 999
    {
        std::fs::create_dir_all(repo_root.join(".fdx")).unwrap();
        let conn = rusqlite::Connection::open(repo_root.join(".fdx").join("index.sqlite")).unwrap();
        conn.execute_batch(
            "
            PRAGMA user_version = 999;
            CREATE TABLE schema_metadata (version INTEGER PRIMARY KEY);
            INSERT INTO schema_metadata (version) VALUES (999);
        ",
        )
        .unwrap();
    }

    // Should fail to open due to future schema
    let result = EvidenceDatabase::open(
        repo_root,
        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
    );
    assert!(result.is_err(), "Should reject future schema versions");
}

#[test]
fn test_corruption_recovery() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let db_path = repo_root.join(".fdx").join("index.sqlite");

    // Write garbage
    std::fs::create_dir_all(repo_root.join(".fdx")).unwrap();
    std::fs::write(&db_path, b"garbage data that is not sqlite").unwrap();

    // Opening should recover (quarantine and rebuild)
    let db = EvidenceDatabase::open(
        repo_root,
        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
    )
    .expect("Failed to open and recover corrupt database");
    assert_eq!(db.get_schema_version().unwrap().version, 10);

    // Check that corrupt DB was moved
    let entries = std::fs::read_dir(repo_root.join(".fdx")).unwrap();
    let corrupt_count = entries
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("index.corrupt.")
        })
        .count();
    assert_eq!(corrupt_count, 1, "Should quarantine corrupt database");
}

#[test]
fn test_busy_contention_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let repo_root = dir.path();

    // Writer A
    let db_a = EvidenceDatabase::open(
        repo_root,
        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
    )
    .unwrap();
    // Writer A takes an exclusive lock
    db_a.conn.execute_batch("BEGIN EXCLUSIVE;").unwrap();

    // Writer B attempts write, should hit busy timeout (5000ms)
    // To not wait 5 seconds in tests, let's change writer B's busy_timeout
    let db_b = EvidenceDatabase::open(
        repo_root,
        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
    )
    .unwrap();
    db_b.conn.pragma_update(None, "busy_timeout", 100).unwrap();

    let result = db_b.conn.execute(
        "INSERT INTO metadata (key, value) VALUES ('test', 'val')",
        [],
    );
    match result {
        Err(rusqlite::Error::SqliteFailure(ffi_err, _)) => {
            assert_eq!(ffi_err.code, rusqlite::ffi::ErrorCode::DatabaseBusy);
        }
        _ => panic!("Expected DatabaseBusy error, got {:?}", result),
    }
}
