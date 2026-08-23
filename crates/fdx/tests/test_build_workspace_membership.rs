//! Blocker 8: npm and Cargo workspace membership semantics tests.

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
fn test_npm_non_member_package_excluded_from_workspace_contains_edges() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

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

    let pkg_member = repo.join("packages/member");
    let pkg_non_member = repo.join("examples/demo");
    fs::create_dir_all(pkg_member.join("src")).unwrap();
    fs::create_dir_all(pkg_non_member.join("src")).unwrap();

    fs::write(
        pkg_member.join("package.json"),
        serde_json::json!({ "name": "@app/member", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(pkg_member.join("src/index.ts"), "export const m = 1;").unwrap();

    fs::write(
        pkg_non_member.join("package.json"),
        serde_json::json!({ "name": "demo-example", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(pkg_non_member.join("src/index.ts"), "export const d = 1;").unwrap();

    git_commit_all(repo, "init");
    let (out, failed) = build_refresh(repo).unwrap();
    assert!(!failed, "Build refresh: {}", out);

    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadOnly).unwrap();

    // Member package has workspace contains edge
    let member_contains: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM edges WHERE from_node = 'workspace:npm:.' AND to_node = 'pkg:npm:packages/member' AND kind = 'contains'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    assert_eq!(member_contains, 1, "Workspace must contain member package");

    // Non-member package MUST NOT have workspace contains edge
    let non_member_contains: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM edges WHERE from_node = 'workspace:npm:.' AND to_node = 'pkg:npm:examples/demo' AND kind = 'contains'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    assert_eq!(
        non_member_contains, 0,
        "Non-member package outside workspace glob must NOT have workspace contains edge"
    );
}

#[test]
fn test_cargo_exclude_prevents_workspace_membership() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    fs::write(
        repo.join("Cargo.toml"),
        r#"[workspace]
members = ["crates/*"]
exclude = ["crates/ignored"]
"#,
    )
    .unwrap();

    let crate_a = repo.join("crates/active");
    let crate_b = repo.join("crates/ignored");
    fs::create_dir_all(crate_a.join("src")).unwrap();
    fs::create_dir_all(crate_b.join("src")).unwrap();

    fs::write(
        crate_a.join("Cargo.toml"),
        r#"[package]
name = "active"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(crate_a.join("src/lib.rs"), "pub fn a() {}").unwrap();

    fs::write(
        crate_b.join("Cargo.toml"),
        r#"[package]
name = "ignored"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(crate_b.join("src/lib.rs"), "pub fn b() {}").unwrap();

    git_commit_all(repo, "init");
    let (out, failed) = build_refresh(repo).unwrap();
    assert!(!failed, "Build refresh: {}", out);

    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadOnly).unwrap();

    let active_contains: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM edges WHERE from_node = 'workspace:cargo:.' AND to_node = 'pkg:cargo:crates/active' AND kind = 'contains'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    assert_eq!(active_contains, 1);

    let ignored_contains: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM edges WHERE from_node = 'workspace:cargo:.' AND to_node = 'pkg:cargo:crates/ignored' AND kind = 'contains'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    assert_eq!(
        ignored_contains, 0,
        "Excluded cargo package must NOT have workspace contains edge"
    );
}
