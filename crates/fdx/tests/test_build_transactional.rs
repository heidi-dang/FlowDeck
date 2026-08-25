use fdx::intelligence::build::ingest::refresh_all_build_providers;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_transactional_rollback_preserves_last_good_generation() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Good initial manifest
    fs::write(
        root.join("package.json"),
        r#"{ "name": "app", "version": "1.0.0", "scripts": { "build": "echo 1" } }"#,
    )
    .unwrap();

    refresh_all_build_providers(root, false).unwrap();

    let db = EvidenceDatabase::open(root, DatabaseOpenMode::ReadOnly).unwrap();
    let nodes_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM nodes WHERE provider = 'build_native'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(nodes_count > 0, "must have nodes published");
    drop(db);

    // Corrupt the manifest
    fs::write(
        root.join("package.json"),
        r#"{ "name": "app", "version": "1.0.0", INVALID_JSON"#,
    )
    .unwrap();

    // Refresh should fail
    let res = refresh_all_build_providers(root, false);
    assert!(res.is_err() || res.unwrap().iter().any(|r| r.failure_reason.is_some()));

    // Verify old generation is preserved, NOT wiped or emptied!
    let db2 = EvidenceDatabase::open(root, DatabaseOpenMode::ReadOnly).unwrap();
    let nodes_count2: i64 = db2
        .conn
        .query_row(
            "SELECT count(*) FROM nodes WHERE provider = 'build_native'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        nodes_count, nodes_count2,
        "old generation must survive failed refresh"
    );
}
