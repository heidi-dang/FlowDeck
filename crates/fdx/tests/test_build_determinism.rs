//! Blocker 7: Deterministic and fail-closed build graph JSON output tests.

use fdx::cmd_build::{build_graph_json, build_refresh};
use sha2::{Digest, Sha256};
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
fn test_build_graph_json_byte_identical_across_10_runs() {
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

    for i in 0..10 {
        let pdir = repo.join(format!("packages/pkg_{}", i));
        fs::create_dir_all(pdir.join("src")).unwrap();
        let deps = if i > 0 {
            serde_json::json!({ format!("@app/pkg_{}", i - 1): "1.0.0" })
        } else {
            serde_json::json!({})
        };
        fs::write(
            pdir.join("package.json"),
            serde_json::json!({
                "name": format!("@app/pkg_{}", i),
                "version": "1.0.0",
                "dependencies": deps,
                "scripts": { "build": "tsc", "test": "vitest" }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(pdir.join("src/index.ts"), "export const x = 1;").unwrap();
    }

    git_commit_all(repo, "init");
    let (out, failed) = build_refresh(repo).unwrap();
    assert!(!failed, "Refresh: {}", out);

    let first_json = build_graph_json(repo).unwrap();
    let first_hash = {
        let mut hasher = Sha256::new();
        hasher.update(first_json.as_bytes());
        format!("{:x}", hasher.finalize())
    };

    for run_idx in 1..10 {
        let current_json = build_graph_json(repo).unwrap();
        let current_hash = {
            let mut hasher = Sha256::new();
            hasher.update(current_json.as_bytes());
            format!("{:x}", hasher.finalize())
        };
        assert_eq!(
            first_hash, current_hash,
            "Run {} hash differed from initial run hash. JSON output must be deterministic and byte-identical.",
            run_idx
        );
        assert_eq!(first_json, current_json);
    }
}
