//! Tests for planner determinism and byte-identical output across repeated runs.

use fdx::intelligence::testplan::planner::plan_verification;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

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
fn test_plan_output_determinism_across_runs() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/pkg1/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg1/tests")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg2/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg2/tests")).unwrap();

    fs::write(
        repo.join("packages/pkg1/package.json"),
        r#"{ "name": "@my/1", "scripts": { "test": "vitest", "lint": "eslint" } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("packages/pkg2/package.json"),
        r#"{ "name": "@my/2", "scripts": { "test": "vitest", "typecheck": "tsc" } }"#,
    )
    .unwrap();

    fs::write(repo.join("packages/pkg1/src/a.ts"), "export const a = 1;").unwrap();
    fs::write(
        repo.join("packages/pkg1/tests/a.test.ts"),
        "test('a', () => {});",
    )
    .unwrap();
    fs::write(repo.join("packages/pkg2/src/b.ts"), "export const b = 1;").unwrap();
    fs::write(
        repo.join("packages/pkg2/tests/b.test.ts"),
        "test('b', () => {});",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    fs::write(repo.join("packages/pkg1/src/a.ts"), "export const a = 2;").unwrap();
    fs::write(repo.join("packages/pkg2/src/b.ts"), "export const b = 2;").unwrap();

    let plan1 = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification 1");
    let json1 = serde_json::to_string_pretty(&plan1).unwrap();

    for _ in 0..10 {
        let plan_n =
            plan_verification(repo, Some("HEAD"), None, None).expect("plan verification N");
        let json_n = serde_json::to_string_pretty(&plan_n).unwrap();
        assert_eq!(
            json1, json_n,
            "Plan output must be byte-identical across runs"
        );
    }
}
