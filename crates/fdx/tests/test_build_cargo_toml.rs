//! Blocker 6: Real Cargo TOML parsing, workspace dependencies, and error handling.

use fdx::cmd_build::build_refresh;
use fdx::intelligence::build::provider::BuildConfigProvider;
use fdx::intelligence::build::target::CargoProvider;
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
fn test_cargo_toml_malformed_syntax_fails_parsing() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    fs::write(
        repo.join("Cargo.toml"),
        r#"[package]
name = "bad"
version = "0.1.0"
invalid toml syntax [[[]]
"#,
    )
    .unwrap();

    let provider = CargoProvider::new();
    let res = provider.ingest(repo);
    assert!(res.is_err(), "Malformed root Cargo.toml must return an Err");
}

#[test]
fn test_cargo_workspace_dependencies_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    fs::write(
        repo.join("Cargo.toml"),
        r#"[workspace]
members = ["crates/core", "crates/cli"]
resolver = "2"

[workspace.dependencies]
core = { path = "crates/core", version = "0.1.0" }
serde = "1.0"
"#,
    )
    .unwrap();

    let core_dir = repo.join("crates/core");
    let cli_dir = repo.join("crates/cli");
    fs::create_dir_all(core_dir.join("src")).unwrap();
    fs::create_dir_all(cli_dir.join("src")).unwrap();

    fs::write(
        core_dir.join("Cargo.toml"),
        r#"[package]
name = "core"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(core_dir.join("src/lib.rs"), "pub fn c() {}").unwrap();

    fs::write(
        cli_dir.join("Cargo.toml"),
        r#"[package]
name = "cli"
version = "0.1.0"
edition = "2021"

[dependencies]
core = { workspace = true }
"#,
    )
    .unwrap();
    fs::write(cli_dir.join("src/main.rs"), "fn main() {}").unwrap();

    git_commit_all(repo, "init");
    let (out, failed) = build_refresh(repo).unwrap();
    assert!(!failed, "Build refresh: {}", out);

    // Verify resolved DependsOn edge in database
    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadOnly).unwrap();
    let edge_exists: bool = db
        .conn
        .query_row(
            "SELECT count(*) FROM edges WHERE from_node = 'pkg:cargo:crates/cli' AND to_node = 'pkg:cargo:crates/core' AND kind = 'depends_on'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    assert!(
        edge_exists,
        "Package dependency edge from cli to core must be created via workspace.dependencies"
    );
}
