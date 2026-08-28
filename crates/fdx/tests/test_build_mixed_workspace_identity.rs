use fdx::cmd_build::build_refresh;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use std::fs;
use tempfile::tempdir;

#[test]
fn test_mixed_npm_and_cargo_workspace_coexistence() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Mixed repository containing both npm package.json and Cargo.toml workspaces
    fs::write(
        root.join("package.json"),
        r#"{"name":"root","private":true,"workspaces":["packages/*"]}"#,
    )
    .unwrap();
    fs::create_dir_all(root.join("packages/web/src")).unwrap();
    fs::write(
        root.join("packages/web/src/index.ts"),
        "export const w = 1;",
    )
    .unwrap();
    fs::write(
        root.join("packages/web/package.json"),
        r#"{"name":"@app/web","version":"1.0.0"}"#,
    )
    .unwrap();

    fs::write(
        root.join("Cargo.toml"),
        r#"[workspace]
members = ["crates/*"]
"#,
    )
    .unwrap();
    fs::create_dir_all(root.join("crates/core/src")).unwrap();
    fs::write(root.join("crates/core/src/lib.rs"), "pub fn run() {}").unwrap();
    fs::write(
        root.join("crates/core/Cargo.toml"),
        r#"[package]
name = "core"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();

    let (res, any_fail) = build_refresh(root).unwrap();
    assert!(
        !any_fail,
        "Build refresh must succeed for both providers: {}",
        res
    );

    let db = EvidenceDatabase::open(root, DatabaseOpenMode::ReadOnly).unwrap();

    // Assert both distinct workspaces exist in DB
    let ws_npm_cnt: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM nodes WHERE stable_id = 'workspace:npm:.'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ws_npm_cnt, 1, "workspace:npm:. must exist");

    let ws_cargo_cnt: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM nodes WHERE stable_id = 'workspace:cargo:.'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ws_cargo_cnt, 1, "workspace:cargo:. must exist");

    // Assert root manifests have defines edges to their respective workspaces
    let defines_npm: i64 = db.conn.query_row(
        "SELECT count(*) FROM edges WHERE from_node = 'file:package.json' AND to_node = 'workspace:npm:.' AND kind = 'defines'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(defines_npm, 1);

    let defines_cargo: i64 = db.conn.query_row(
        "SELECT count(*) FROM edges WHERE from_node = 'file:Cargo.toml' AND to_node = 'workspace:cargo:.' AND kind = 'defines'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(defines_cargo, 1);
}
