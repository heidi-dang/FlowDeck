//! Blocker 4: Discovery limits and fail-closed bounds tests.

use fdx::cmd_build::build_refresh;
use fdx::intelligence::build::discover::{discover_build_files, MAX_DISCOVERED_PACKAGES};
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
fn test_package_discovery_limit_exceeded_fails_closed() {
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

    // Create 501 package manifests (limit is 500)
    for i in 0..501 {
        let pdir = repo.join(format!("packages/pkg_{:04}", i));
        fs::create_dir_all(pdir.join("src")).unwrap();
        fs::write(
            pdir.join("package.json"),
            serde_json::json!({ "name": format!("@app/pkg_{:04}", i), "version": "1.0.0" })
                .to_string(),
        )
        .unwrap();
        fs::write(pdir.join("src/index.ts"), "export const x = 1;").unwrap();
    }

    let files = discover_build_files(repo);
    assert_eq!(files.package_jsons.len(), MAX_DISCOVERED_PACKAGES);
    assert!(
        files.package_jsons_truncated,
        "Truncation flag must be true when packages exceed limit"
    );

    git_commit_all(repo, "init");
    let _ = build_refresh(repo);

    // Modify a package
    fs::write(
        repo.join("packages/pkg_0000/src/index.ts"),
        "export const x = 2;",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Expected: BuildLimitReached uncertainty emitted
    assert!(
        result
            .uncertainty
            .iter()
            .any(|u| u.code() == "build_limit_reached"),
        "BuildLimitReached must be emitted when discovery bounds are exceeded"
    );

    // Cannot qualify as Exact
    assert_ne!(
        result.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact when discovery is truncated"
    );
}
