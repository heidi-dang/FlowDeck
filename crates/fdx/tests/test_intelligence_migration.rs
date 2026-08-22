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

    // Open ReadWrite -> should migrate 0 to the current schema version (2)
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    assert_eq!(db.get_schema_version().unwrap().version, 2);

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

#[test]
fn test_v1_to_v2_migration_preserves_data() {
    let dir = tempfile::tempdir().unwrap();
    let repo_root = dir.path();
    let fdx_dir = repo_root.join(".fdx");
    std::fs::create_dir_all(&fdx_dir).unwrap();
    let db_path = fdx_dir.join("index.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_metadata (version INTEGER PRIMARY KEY);
         INSERT INTO schema_metadata (version) VALUES (1);
         CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE files (canonical_path TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
                             size INTEGER NOT NULL, mtime_ms INTEGER, language TEXT, indexed_at INTEGER NOT NULL);
         CREATE TABLE nodes (stable_id TEXT PRIMARY KEY, kind TEXT NOT NULL, canonical_path TEXT,
                             symbol_identity TEXT, package_identity TEXT, metadata TEXT);
         CREATE TABLE edges (stable_id TEXT PRIMARY KEY, from_node TEXT NOT NULL, to_node TEXT NOT NULL,
                             kind TEXT NOT NULL, provider TEXT NOT NULL, provider_fingerprint TEXT NOT NULL,
                             strength INTEGER NOT NULL, source_identity TEXT, source_hash TEXT,
                             created_revision INTEGER NOT NULL, updated_revision INTEGER NOT NULL,
                             stale BOOLEAN NOT NULL DEFAULT 0);
         CREATE TABLE provider_state (provider TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                                      compatibility_data TEXT);
         PRAGMA user_version = 1;
         INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('a.rs', 'h1', 3, 0);"
    )
    .unwrap();
    drop(conn);

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    assert_eq!(db.get_schema_version().unwrap().version, 2);
    let files: i64 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .unwrap();
    assert_eq!(files, 1, "pre-existing v1 data survives the migration");
    let providers: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'semantic_providers'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(providers, 1, "v2 semantic_providers table exists");
    let cols: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('nodes') WHERE name = 'provider'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cols, 1, "nodes provider column added");
}

#[test]
fn test_migration_failure_rolls_back_to_v1() {
    let dir = tempfile::tempdir().unwrap();
    let repo_root = dir.path();
    let fdx_dir = repo_root.join(".fdx");
    std::fs::create_dir_all(&fdx_dir).unwrap();
    let db_path = fdx_dir.join("index.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_metadata (version INTEGER PRIMARY KEY);
         INSERT INTO schema_metadata (version) VALUES (1);
         CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         PRAGMA user_version = 1;",
    )
    .unwrap();
    drop(conn);
    // Missing files/nodes tables => ALTER during 1->2 fails => tx rollback.
    let result = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite);
    assert!(result.is_err(), "migration must fail closed");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let version: u32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1, "rollback must preserve v1");
}
