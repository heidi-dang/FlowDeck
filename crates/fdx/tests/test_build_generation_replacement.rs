//! Blocker 5: Transactional generation replacement and obsolete node cleanup.

use fdx::cmd_build::build_refresh;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use std::fs;
use std::path::Path;
use std::process::Command;

fn init_git_repo(path: &Path) {
    let _ = Command::new("git")
        .args(["init", "--initial-branch=main"])
        .current_dir(path)
        .output();
    let _ = Command::new("git")
        .args(["config", "user.name", "Test Agent"])
        .current_dir(path)
        .output();
    let _ = Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(path)
        .output();
}

fn git_commit_all(path: &Path, msg: &str) {
    let _ = Command::new("git")
        .args(["add", "-A"])
        .current_dir(path)
        .output();
    let _ = Command::new("git")
        .args(["commit", "-m", msg, "--allow-empty"])
        .current_dir(path)
        .output();
}

#[test]
fn test_successful_refresh_removes_obsolete_provider_nodes_and_edges() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    // Generation 1: packages/a and packages/b
    fs::write(
        repo.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*"]
        })
        .to_string(),
    )
    .unwrap();

    let pkg_a = repo.join("packages/a");
    let pkg_b = repo.join("packages/b");
    fs::create_dir_all(pkg_a.join("src")).unwrap();
    fs::create_dir_all(pkg_b.join("src")).unwrap();

    fs::write(
        pkg_a.join("package.json"),
        serde_json::json!({ "name": "@app/a", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(pkg_a.join("src/index.ts"), "export const a = 1;").unwrap();

    fs::write(
        pkg_b.join("package.json"),
        serde_json::json!({ "name": "@app/b", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(pkg_b.join("src/index.ts"), "export const b = 1;").unwrap();

    git_commit_all(repo, "gen_1");

    // Ingest gen 1
    let (out1, failed1) = build_refresh(repo).unwrap();
    assert!(!failed1, "Gen 1 refresh: {}", out1);

    // Verify pkg-b node exists in DB
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadOnly).unwrap();
        let b_node: Option<String> = db
            .conn
            .query_row(
                "SELECT stable_id FROM nodes WHERE stable_id = 'pkg:npm:packages/b'",
                [],
                |r| r.get(0),
            )
            .ok();
        assert_eq!(b_node, Some("pkg:npm:packages/b".to_string()));
    }

    // Generation 2: Delete packages/b/package.json
    fs::remove_file(pkg_b.join("package.json")).unwrap();
    git_commit_all(repo, "gen_2");

    let (out2, failed2) = build_refresh(repo).unwrap();
    assert!(!failed2, "Gen 2 refresh: {}", out2);

    // Verify pkg-b node and all pkg-b provider-owned edges are GONE
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadOnly).unwrap();

        let b_node: Option<String> = db
            .conn
            .query_row(
                "SELECT stable_id FROM nodes WHERE stable_id = 'pkg:npm:packages/b'",
                [],
                |r| r.get(0),
            )
            .ok();
        assert!(
            b_node.is_none(),
            "Obsolete node pkg:npm:packages/b must be removed in generation 2"
        );

        let b_edges_count: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM edges WHERE from_node = 'pkg:npm:packages/b' OR to_node = 'pkg:npm:packages/b'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        assert_eq!(
            b_edges_count, 0,
            "All edges attached to obsolete pkg-b must be gone"
        );

        // Verify shared file node still survives or pkg-a node is present
        let a_node: Option<String> = db
            .conn
            .query_row(
                "SELECT stable_id FROM nodes WHERE stable_id = 'pkg:npm:packages/a'",
                [],
                |r| r.get(0),
            )
            .ok();
        assert_eq!(a_node, Some("pkg:npm:packages/a".to_string()));
    }
}
