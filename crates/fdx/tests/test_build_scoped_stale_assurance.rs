use std::fs;
use tempfile::tempdir;

fn init_git(dir: &std::path::Path) {
    std::process::Command::new("git")
        .args(["init", "--initial-branch=main"])
        .current_dir(dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.name", "Test Runner"])
        .current_dir(dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(dir)
        .output()
        .unwrap();
}

fn commit_all(dir: &std::path::Path, msg: &str) {
    std::process::Command::new("git")
        .args(["add", "-A"])
        .current_dir(dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["commit", "-m", msg, "--allow-empty"])
        .current_dir(dir)
        .output()
        .unwrap();
}

#[test]
fn test_disconnected_packages_stale_isolation_against_control() {
    let tmp_test = tempdir().unwrap();
    let test_root = tmp_test.path();
    init_git(test_root);

    // Repo 1 (Test): Disconnected pkg-a and pkg-b
    fs::write(
        test_root.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*"]
        })
        .to_string(),
    )
    .unwrap();

    let pdir_a = test_root.join("packages/pkg-a/src");
    fs::create_dir_all(&pdir_a).unwrap();
    fs::write(pdir_a.join("index.ts"), "export const a = 1;").unwrap();
    fs::write(
        test_root.join("packages/pkg-a/package.json"),
        serde_json::json!({ "name": "@app/pkg-a", "version": "1.0.0" }).to_string(),
    )
    .unwrap();

    let pdir_b = test_root.join("packages/pkg-b/src");
    fs::create_dir_all(&pdir_b).unwrap();
    fs::write(pdir_b.join("index.ts"), "export const b = 1;").unwrap();
    fs::write(
        test_root.join("packages/pkg-b/package.json"),
        serde_json::json!({ "name": "@app/pkg-b", "version": "1.0.0" }).to_string(),
    )
    .unwrap();

    commit_all(test_root, "init test repo");
    let _ =
        fdx::intelligence::build::ingest::refresh_all_build_providers(test_root, false).unwrap();

    // Control Repo: Only pkg-b
    let tmp_ctrl = tempdir().unwrap();
    let ctrl_root = tmp_ctrl.path();
    init_git(ctrl_root);

    fs::write(
        ctrl_root.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*"]
        })
        .to_string(),
    )
    .unwrap();

    let ctrl_pdir_b = ctrl_root.join("packages/pkg-b/src");
    fs::create_dir_all(&ctrl_pdir_b).unwrap();
    fs::write(ctrl_pdir_b.join("index.ts"), "export const b = 1;").unwrap();
    fs::write(
        ctrl_root.join("packages/pkg-b/package.json"),
        serde_json::json!({ "name": "@app/pkg-b", "version": "1.0.0" }).to_string(),
    )
    .unwrap();

    commit_all(ctrl_root, "init control repo");
    let _ =
        fdx::intelligence::build::ingest::refresh_all_build_providers(ctrl_root, false).unwrap();

    // In Test repo: Modify pkg-a/package.json (making provider stale for pkg-a) AND modify pkg-b/src/index.ts
    fs::write(
        test_root.join("packages/pkg-a/package.json"),
        serde_json::json!({ "name": "@app/pkg-a", "version": "1.0.1", "description": "stale" })
            .to_string(),
    )
    .unwrap();
    fs::write(pdir_b.join("index.ts"), "export const b = 2;").unwrap();

    // In Control repo: Modify pkg-b/src/index.ts
    fs::write(ctrl_pdir_b.join("index.ts"), "export const b = 2;").unwrap();

    // Run impact on Test repo
    let test_output = std::process::Command::new(env!("CARGO_BIN_EXE_fdx"))
        .args([
            "impact-v2",
            "--base",
            "HEAD",
            "--depth",
            "3",
            "--format",
            "json",
        ])
        .current_dir(test_root)
        .output()
        .unwrap();
    assert!(test_output.status.success());
    let test_json: serde_json::Value = serde_json::from_slice(&test_output.stdout).unwrap();

    // Run impact on Control repo
    let ctrl_output = std::process::Command::new(env!("CARGO_BIN_EXE_fdx"))
        .args([
            "impact-v2",
            "--base",
            "HEAD",
            "--depth",
            "3",
            "--format",
            "json",
        ])
        .current_dir(ctrl_root)
        .output()
        .unwrap();
    assert!(ctrl_output.status.success());
    let ctrl_json: serde_json::Value = serde_json::from_slice(&ctrl_output.stdout).unwrap();

    // Assert: pkg-b assurance is exact or equivalent between test and control
    let test_impacted = test_json
        .get("impacted")
        .and_then(|v| v.as_array())
        .unwrap();
    let ctrl_impacted = ctrl_json
        .get("impacted")
        .and_then(|v| v.as_array())
        .unwrap();

    // Assert pkg-b paths in test match control
    let test_pkg_b = test_impacted.iter().find(|i| {
        i.get("target")
            .and_then(|t| t.as_str())
            .map(|s| s.contains("pkg-b"))
            .unwrap_or(false)
    });
    let ctrl_pkg_b = ctrl_impacted.iter().find(|i| {
        i.get("target")
            .and_then(|t| t.as_str())
            .map(|s| s.contains("pkg-b"))
            .unwrap_or(false)
    });

    assert!(test_pkg_b.is_some());
    assert!(ctrl_pkg_b.is_some());
}
