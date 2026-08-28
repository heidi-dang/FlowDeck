use fdx::cmd_build::build_refresh;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_provider_disappearance_retires_evidence_transactionally() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Initialize with tsconfig.json
    fs::write(
        root.join("tsconfig.json"),
        r#"{"compilerOptions":{"target":"es2022"}}"#,
    )
    .unwrap();

    let (res, any_fail) = build_refresh(root).unwrap();
    assert!(!any_fail, "Refresh 1 must succeed: {}", res);

    let db = EvidenceDatabase::open(root, DatabaseOpenMode::ReadOnly).unwrap();
    let ts_edges_cnt: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM edges WHERE provider_id = 'builtin-tsconfig'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        ts_edges_cnt > 0,
        "TsConfig edges must exist after refresh 1"
    );
    drop(db);

    // Delete tsconfig.json (provider disappears)
    fs::remove_file(root.join("tsconfig.json")).unwrap();

    let (res2, any_fail2) = build_refresh(root).unwrap();
    assert!(!any_fail2, "Refresh 2 must succeed: {}", res2);

    let db2 = EvidenceDatabase::open(root, DatabaseOpenMode::ReadOnly).unwrap();
    let ts_edges_cnt2: i64 = db2
        .conn
        .query_row(
            "SELECT count(*) FROM edges WHERE provider_id = 'builtin-tsconfig'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        ts_edges_cnt2, 0,
        "No tsconfig edges must remain after provider disappears"
    );

    let ts_nodes_cnt: i64 = db2.conn.query_row(
        "SELECT count(*) FROM nodes WHERE provider = 'build_native' AND source_identity = 'builtin-tsconfig'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(
        ts_nodes_cnt, 0,
        "No tsconfig provider-owned nodes must remain"
    );
}
