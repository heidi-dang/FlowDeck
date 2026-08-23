use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::protocol::AssuranceLevel;
use std::fs;
use std::process::Command;
use tempfile::tempdir;

fn init_git_repo(dir: &std::path::Path) {
    Command::new("git")
        .args(["init", "--initial-branch=main"])
        .current_dir(dir)
        .output()
        .unwrap();
    Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(dir)
        .output()
        .unwrap();
    Command::new("git")
        .args(["config", "user.email", "test@test.com"])
        .current_dir(dir)
        .output()
        .unwrap();
}

fn git_commit(dir: &std::path::Path, msg: &str) {
    Command::new("git")
        .args(["add", "-A"])
        .current_dir(dir)
        .output()
        .unwrap();
    Command::new("git")
        .args(["commit", "-m", msg, "--allow-empty"])
        .current_dir(dir)
        .output()
        .unwrap();
}

#[test]
fn test_stale_new_dependency_reconstructed_from_current_snapshot() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    init_git_repo(root);

    // T0: A depends on B
    fs::write(
        root.join("package.json"),
        r#"{"name":"root","private":true,"workspaces":["packages/*"]}"#,
    )
    .unwrap();

    fs::create_dir_all(root.join("packages/a/src")).unwrap();
    fs::write(root.join("packages/a/src/index.ts"), "export const a = 1;").unwrap();
    fs::write(
        root.join("packages/a/package.json"),
        r#"{"name":"@app/a","version":"1.0.0","dependencies":{"@app/b":"1.0.0"}}"#,
    )
    .unwrap();

    fs::create_dir_all(root.join("packages/b/src")).unwrap();
    fs::write(root.join("packages/b/src/index.ts"), "export const b = 1;").unwrap();
    fs::write(
        root.join("packages/b/package.json"),
        r#"{"name":"@app/b","version":"1.0.0"}"#,
    )
    .unwrap();

    fs::create_dir_all(root.join("packages/c/src")).unwrap();
    fs::write(root.join("packages/c/src/index.ts"), "export const c = 1;").unwrap();
    fs::write(
        root.join("packages/c/package.json"),
        r#"{"name":"@app/c","version":"1.0.0"}"#,
    )
    .unwrap();

    git_commit(root, "T0");

    // Build refresh at T0
    let res = fdx::cmd_build::build_refresh(root).unwrap();
    assert!(!res.1);

    // T1: A now depends on C (no build refresh!)
    fs::write(
        root.join("packages/a/package.json"),
        r#"{"name":"@app/a","version":"1.0.0","dependencies":{"@app/c":"1.0.0"}}"#,
    )
    .unwrap();
    git_commit(root, "T1");

    // Working tree: only modify packages/c/src/index.ts
    fs::write(root.join("packages/c/src/index.ts"), "export const c = 2;").unwrap();

    // Impact analysis relative to HEAD
    let impact = analyze_impact_v2(root, Some("HEAD"), None, Some(3)).unwrap();

    // Assert: package A is impacted through the newly introduced dependency A -> C
    let has_pkg_a = impact
        .impacted
        .iter()
        .any(|t| t.target == "packages/a" || t.target == "packages/a/src/index.ts");
    assert!(
        has_pkg_a,
        "Package A must be impacted by change in C via current snapshot topology: {:?}",
        impact.impacted
    );

    // Assurance should be Degraded because build provider is stale
    assert!(impact.assurance <= AssuranceLevel::Degraded);
    assert!(impact
        .uncertainty
        .iter()
        .any(|u| u.code() == "build_provider_stale"));
}
