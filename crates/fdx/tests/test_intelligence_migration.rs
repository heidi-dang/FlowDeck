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

    // Open ReadWrite -> should migrate v0 through all additive migrations to the current schema version.
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    assert_eq!(db.get_schema_version().unwrap().version, 10);

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
    let dir = tempdir().unwrap();
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
         INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('a.rs', 'h1', 3, 0);",
    )
    .unwrap();
    drop(conn);

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    assert_eq!(db.get_schema_version().unwrap().version, 10);
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
    let attempt_cols: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('semantic_providers') WHERE name = 'last_attempt_fingerprint'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(attempt_cols, 1, "v3 last_attempt_fingerprint column added");
    let node_src_cols: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('nodes') WHERE name = 'source_identity'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(node_src_cols, 1, "v4 nodes source_identity column added");
    let edge_pid_cols: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('edges') WHERE name = 'provider_id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(edge_pid_cols, 1, "v5 edges provider_id column added");
}

#[test]
fn test_v3_to_v4_migration_adds_node_source_identity() {
    let dir = tempfile::tempdir().unwrap();
    let repo_root = dir.path();
    let fdx_dir = repo_root.join(".fdx");
    std::fs::create_dir_all(&fdx_dir).unwrap();
    let db_path = fdx_dir.join("index.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(fdx::intelligence::schema::INITIALIZE_SCHEMA_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V1_TO_V2_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V2_TO_V3_SQL)
        .unwrap();
    conn.pragma_update(None, "user_version", 3).unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO schema_metadata (version) VALUES (3)",
        [],
    )
    .unwrap();
    drop(conn);

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    assert_eq!(db.get_schema_version().unwrap().version, 10);
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('nodes') WHERE name = 'source_identity'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "v4 nodes source_identity column created");
}

#[test]
fn test_v4_to_v5_migration_adds_edge_provider_id() {
    let dir = tempfile::tempdir().unwrap();
    let repo_root = dir.path();
    let fdx_dir = repo_root.join(".fdx");
    std::fs::create_dir_all(&fdx_dir).unwrap();
    let db_path = fdx_dir.join("index.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(fdx::intelligence::schema::INITIALIZE_SCHEMA_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V1_TO_V2_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V2_TO_V3_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V3_TO_V4_SQL)
        .unwrap();
    conn.pragma_update(None, "user_version", 4).unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO schema_metadata (version) VALUES (4)",
        [],
    )
    .unwrap();
    drop(conn);

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    assert_eq!(db.get_schema_version().unwrap().version, 10);
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('edges') WHERE name = 'provider_id'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "v5 edges provider_id column created");
}

#[test]
fn test_v2_to_v3_migration_adds_attempt_columns() {
    let dir = tempfile::tempdir().unwrap();
    let repo_root = dir.path();
    let fdx_dir = repo_root.join(".fdx");
    std::fs::create_dir_all(&fdx_dir).unwrap();
    let db_path = fdx_dir.join("index.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(fdx::intelligence::schema::INITIALIZE_SCHEMA_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V1_TO_V2_SQL)
        .unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO schema_metadata (version) VALUES (2)",
        [],
    )
    .unwrap();
    drop(conn);

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    assert_eq!(db.get_schema_version().unwrap().version, 10);
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('semantic_providers') WHERE name = 'last_attempt_fingerprint'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "v3 attempt diagnostics column created");
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
    assert!(result.is_err(), "Broken migration must fail");

    let conn2 = rusqlite::Connection::open(&db_path).unwrap();
    let v: u32 = conn2
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 1, "Rollback leaves user_version at 1");
}
#[test]
fn test_v5_to_v6_migration_adds_runtime_tables() {
    let dir = tempfile::tempdir().unwrap();
    let repo_root = dir.path();
    let fdx_dir = repo_root.join(".fdx");
    std::fs::create_dir_all(&fdx_dir).unwrap();
    let db_path = fdx_dir.join("index.sqlite");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute_batch(fdx::intelligence::schema::INITIALIZE_SCHEMA_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V1_TO_V2_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V2_TO_V3_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V3_TO_V4_SQL)
        .unwrap();
    conn.execute_batch(fdx::intelligence::schema::MIGRATE_V4_TO_V5_SQL)
        .unwrap();
    conn.pragma_update(None, "user_version", 5).unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO schema_metadata (version) VALUES (5)",
        [],
    )
    .unwrap();
    drop(conn);

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    assert_eq!(db.get_schema_version().unwrap().version, 10);
    let count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='runtime_runs'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "v6 runtime_runs table created");
}
