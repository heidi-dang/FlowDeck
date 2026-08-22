//! Blocker 1: Effective build provider freshness and fingerprint qualification tests.

use fdx::cmd_build::build_refresh;
use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::protocol::AssuranceLevel;
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
fn test_stale_dependency_rewrite_widens_and_emits_build_provider_stale() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    // Initial: A depends on B
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
    let pkg_c = repo.join("packages/c");
    fs::create_dir_all(pkg_a.join("src")).unwrap();
    fs::create_dir_all(pkg_b.join("src")).unwrap();
    fs::create_dir_all(pkg_c.join("src")).unwrap();

    fs::write(
        pkg_a.join("package.json"),
        serde_json::json!({
            "name": "@app/a",
            "version": "1.0.0",
            "dependencies": { "@app/b": "1.0.0" }
        })
        .to_string(),
    )
    .unwrap();
    fs::write(pkg_a.join("src/index.ts"), "export const a = 1;").unwrap();

    fs::write(
        pkg_b.join("package.json"),
        serde_json::json!({
            "name": "@app/b",
            "version": "1.0.0"
        })
        .to_string(),
    )
    .unwrap();
    fs::write(pkg_b.join("src/index.ts"), "export const b = 1;").unwrap();

    fs::write(
        pkg_c.join("package.json"),
        serde_json::json!({
            "name": "@app/c",
            "version": "1.0.0"
        })
        .to_string(),
    )
    .unwrap();
    fs::write(pkg_c.join("src/index.ts"), "export const c = 1;").unwrap();

    git_commit_all(repo, "initial");

    // Ingest initial build graph
    let (out, failed) = build_refresh(repo).unwrap();
    assert!(!failed, "Initial build refresh should succeed: {}", out);

    // Now, without refresh: package A manifest changes and now depends on C
    fs::write(
        pkg_a.join("package.json"),
        serde_json::json!({
            "name": "@app/a",
            "version": "1.0.0",
            "dependencies": { "@app/c": "1.0.0" }
        })
        .to_string(),
    )
    .unwrap();

    // Modify C source
    fs::write(pkg_c.join("src/index.ts"), "export const c = 2;").unwrap();

    // Analyze impact
    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Package A must NOT be omitted
    let target_a = result
        .impacted
        .iter()
        .find(|t| t.target == "packages/a" || t.target == "packages/a/package.json");
    assert!(
        target_a.is_some(),
        "Package A must be included when C changes and A depends on C in working tree"
    );

    // BuildProviderStale must be emitted
    assert!(
        result
            .uncertainty
            .iter()
            .any(|u| u.code() == "build_provider_stale"),
        "BuildProviderStale must be present in uncertainty list"
    );

    // Assurance <= Degraded
    assert!(
        result.assurance <= AssuranceLevel::Degraded,
        "Assurance must be <= Degraded due to stale build provider"
    );
}

#[test]
fn test_fingerprint_mismatch_downgrades_edge_and_requires_widening() {
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
    let pkg_a = repo.join("packages/a");
    fs::create_dir_all(pkg_a.join("src")).unwrap();
    fs::write(
        pkg_a.join("package.json"),
        serde_json::json!({ "name": "@app/a", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(pkg_a.join("src/index.ts"), "export const a = 1;").unwrap();
    git_commit_all(repo, "init");

    let (out, failed) = build_refresh(repo).unwrap();
    assert!(!failed, "Refresh: {}", out);

    // Tamper with package.json on disk (changes current fingerprint)
    fs::write(
        pkg_a.join("package.json"),
        serde_json::json!({ "name": "@app/a", "version": "1.0.1" }).to_string(),
    )
    .unwrap();
    fs::write(pkg_a.join("src/index.ts"), "export const a = 2;").unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    assert!(
        result
            .uncertainty
            .iter()
            .any(|u| u.code() == "build_provider_stale"),
        "BuildProviderStale must be emitted on fingerprint mismatch"
    );
    assert_ne!(result.assurance, AssuranceLevel::Exact);
}
