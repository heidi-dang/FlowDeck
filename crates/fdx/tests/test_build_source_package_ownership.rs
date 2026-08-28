//! Blocker 3: Connect ordinary source files to owning packages/build targets.

use fdx::cmd_build::build_refresh;
use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::protocol::NodeKind;
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
fn test_npm_source_file_change_impacts_dependent_package_without_direct_source_imports() {
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

    let pkg_core = repo.join("packages/core");
    let pkg_web = repo.join("packages/web");
    fs::create_dir_all(pkg_core.join("src")).unwrap();
    fs::create_dir_all(pkg_web.join("src")).unwrap();

    fs::write(
        pkg_core.join("package.json"),
        serde_json::json!({
            "name": "@app/core",
            "version": "1.0.0"
        })
        .to_string(),
    )
    .unwrap();
    // packages/core/src/index.ts has arbitrary function
    fs::write(
        pkg_core.join("src/index.ts"),
        "export function calculate(): number { return 42; }",
    )
    .unwrap();

    fs::write(
        pkg_web.join("package.json"),
        serde_json::json!({
            "name": "@app/web",
            "version": "1.0.0",
            "dependencies": {
                "@app/core": "1.0.0"
            }
        })
        .to_string(),
    )
    .unwrap();
    // packages/web/src/index.ts does NOT import calculate or index.ts directly (no source import rescue)
    fs::write(
        pkg_web.join("src/index.ts"),
        "export const appTitle = 'Web App';",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    // Ingest build graph
    let (out, failed) = build_refresh(repo).unwrap();
    assert!(!failed, "Build refresh failed: {}", out);

    // Modify packages/core/src/index.ts
    fs::write(
        pkg_core.join("src/index.ts"),
        "export function calculate(): number { return 100; }",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Check that packages/web is included in impacted targets through package dependency evidence
    let web_target = result.impacted.iter().find(|t| t.target == "packages/web");
    assert!(
        web_target.is_some(),
        "Dependent package packages/web must be impacted when packages/core source file changes. Impacted list: {:?}",
        result.impacted
    );
    let web = web_target.unwrap();
    assert_eq!(web.target_kind, NodeKind::Package);

    // Verify explanation path
    if let Some(ref path) = web.primary_path {
        assert!(
            path.steps
                .iter()
                .any(|s| s.edge_kind == fdx::protocol::EdgeKind::Contains),
            "Path should contain Contains edge connecting package to file"
        );
        assert!(
            path.steps
                .iter()
                .any(|s| s.edge_kind == fdx::protocol::EdgeKind::DependsOn),
            "Path should contain DependsOn edge connecting web to core"
        );
    }
}

#[test]
fn test_cargo_source_file_change_impacts_dependent_crate() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    fs::write(
        repo.join("Cargo.toml"),
        r#"[workspace]
members = [
  "crates/core",
  "crates/cli",
]
"#,
    )
    .unwrap();

    let crate_core = repo.join("crates/core");
    let crate_cli = repo.join("crates/cli");
    fs::create_dir_all(crate_core.join("src/internal")).unwrap();
    fs::create_dir_all(crate_cli.join("src")).unwrap();

    fs::write(
        crate_core.join("Cargo.toml"),
        r#"[package]
name = "core"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(crate_core.join("src/lib.rs"), "pub fn base() {}").unwrap();
    fs::write(
        crate_core.join("src/internal/foo.rs"),
        "pub fn internal_foo() -> i32 { 1 }",
    )
    .unwrap();

    fs::write(
        crate_cli.join("Cargo.toml"),
        r#"[package]
name = "cli"
version = "0.1.0"
edition = "2021"

[dependencies]
core = { path = "../core" }
"#,
    )
    .unwrap();
    fs::write(crate_cli.join("src/main.rs"), "fn main() {}").unwrap();

    git_commit_all(repo, "initial");
    let (out, failed) = build_refresh(repo).unwrap();
    assert!(!failed, "Build refresh: {}", out);

    // Modify internal file without direct import
    fs::write(
        crate_core.join("src/internal/foo.rs"),
        "pub fn internal_foo() -> i32 { 99 }",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    let cli_target = result.impacted.iter().find(|t| t.target == "crates/cli");
    assert!(
        cli_target.is_some(),
        "crates/cli must be impacted when crates/core internal source changes"
    );
}

#[test]
fn test_nested_package_ownership_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    fs::write(
        repo.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*", "packages/*/examples/*"]
        })
        .to_string(),
    )
    .unwrap();

    let pkg_a = repo.join("packages/a");
    let pkg_nested_b = repo.join("packages/a/examples/b");
    fs::create_dir_all(pkg_a.join("src")).unwrap();
    fs::create_dir_all(pkg_nested_b.join("src")).unwrap();

    fs::write(
        pkg_a.join("package.json"),
        serde_json::json!({ "name": "@app/a", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(pkg_a.join("src/a.ts"), "export const a = 1;").unwrap();

    fs::write(
        pkg_nested_b.join("package.json"),
        serde_json::json!({ "name": "@app/b", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(pkg_nested_b.join("src/b.ts"), "export const b = 2;").unwrap();

    git_commit_all(repo, "initial");
    let (out, failed) = build_refresh(repo).unwrap();
    assert!(!failed, "Build refresh: {}", out);

    // Modify nested b source
    fs::write(pkg_nested_b.join("src/b.ts"), "export const b = 99;").unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Nested package b should be impacted, but parent package a should not be falsely impacted
    let b_target = result
        .impacted
        .iter()
        .find(|t| t.target == "packages/a/examples/b");
    let a_target = result.impacted.iter().find(|t| t.target == "packages/a");

    assert!(b_target.is_some(), "Nearest package b must own nested file");
    assert!(
        a_target.is_none(),
        "Parent package a must NOT falsely own nested b's files"
    );
}
