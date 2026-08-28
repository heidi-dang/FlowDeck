use fdx::intelligence::change::traverse::analyze_impact_v2;
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
fn test_disconnected_packages_stale_isolation() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    init_git_repo(root);

    // Monorepo with disconnected packages A and B
    fs::write(
        root.join("package.json"),
        r#"{"name":"root","private":true,"workspaces":["packages/*"]}"#,
    )
    .unwrap();

    fs::create_dir_all(root.join("packages/a/src")).unwrap();
    fs::write(root.join("packages/a/src/index.ts"), "export const a = 1;").unwrap();
    fs::write(
        root.join("packages/a/package.json"),
        r#"{"name":"@app/a","version":"1.0.0"}"#,
    )
    .unwrap();

    fs::create_dir_all(root.join("packages/b/src")).unwrap();
    fs::write(root.join("packages/b/src/index.ts"), "export const b = 1;").unwrap();
    fs::write(
        root.join("packages/b/package.json"),
        r#"{"name":"@app/b","version":"1.0.0"}"#,
    )
    .unwrap();

    git_commit(root, "init");
    fdx::cmd_build::build_refresh(root).unwrap();

    // Clean control repo for B
    let control_dir = tempdir().unwrap();
    let control_root = control_dir.path();
    init_git_repo(control_root);
    fs::write(
        control_root.join("package.json"),
        r#"{"name":"root","private":true,"workspaces":["packages/*"]}"#,
    )
    .unwrap();
    fs::create_dir_all(control_root.join("packages/b/src")).unwrap();
    fs::write(
        control_root.join("packages/b/src/index.ts"),
        "export const b = 1;",
    )
    .unwrap();
    fs::write(
        control_root.join("packages/b/package.json"),
        r#"{"name":"@app/b","version":"1.0.0"}"#,
    )
    .unwrap();
    git_commit(control_root, "init");
    fdx::cmd_build::build_refresh(control_root).unwrap();

    // In test repo: modify packages/a/package.json (A becomes stale) and packages/b/src/index.ts
    fs::write(
        root.join("packages/a/package.json"),
        r#"{"name":"@app/a","version":"1.0.1"}"#,
    )
    .unwrap();
    fs::write(root.join("packages/b/src/index.ts"), "export const b = 2;").unwrap();

    // In control repo: modify packages/b/src/index.ts
    fs::write(
        control_root.join("packages/b/src/index.ts"),
        "export const b = 2;",
    )
    .unwrap();

    let test_impact = analyze_impact_v2(root, Some("HEAD"), None, Some(3)).unwrap();
    let control_impact = analyze_impact_v2(control_root, Some("HEAD"), None, Some(3)).unwrap();

    // Assert that B's assurance in test repo is not degraded below control
    assert_eq!(test_impact.assurance, control_impact.assurance);
}
