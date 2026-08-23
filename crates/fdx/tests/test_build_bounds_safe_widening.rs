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
fn test_bounds_safe_widening_on_repository_truncation() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    init_git(repo_root);

    // Root package.json
    fs::write(
        repo_root.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*"]
        })
        .to_string(),
    )
    .unwrap();

    // Create 4 packages: pkg-a -> pkg-b -> pkg-c -> pkg-d
    for name in ["pkg-a", "pkg-b", "pkg-c", "pkg-d"] {
        let pdir = repo_root.join("packages").join(name);
        fs::create_dir_all(pdir.join("src")).unwrap();
        fs::write(pdir.join("src").join("index.ts"), "export const x = 1;").unwrap();
        fs::write(
            pdir.join("package.json"),
            serde_json::json!({
                "name": format!("@app/{}", name),
                "version": "1.0.0"
            })
            .to_string(),
        )
        .unwrap();
    }

    commit_all(repo_root, "init");

    // Refresh build graph
    let reports =
        fdx::intelligence::build::ingest::refresh_all_build_providers(repo_root, false).unwrap();
    assert!(!reports.is_empty());

    // Modify pkg-d
    fs::write(
        repo_root.join("packages/pkg-d/src/index.ts"),
        "export const x = 2;",
    )
    .unwrap();

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_fdx"))
        .args([
            "impact-v2",
            "--base",
            "HEAD",
            "--depth",
            "3",
            "--format",
            "json",
        ])
        .current_dir(repo_root)
        .output()
        .unwrap();

    assert!(output.status.success());
    let res_json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();

    let impacted = res_json.get("impacted").and_then(|v| v.as_array()).unwrap();
    assert!(impacted.iter().any(|item| {
        item.get("target")
            .and_then(|t| t.as_str())
            .map(|s| s.contains("packages/pkg-d"))
            .unwrap_or(false)
    }));
}
