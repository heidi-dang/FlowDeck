//! Tests for M5 fallback package topology integration with M6 test obligations.

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
fn test_m5_fallback_only_package_retains_m6_test_obligation() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::write(
        repo.join("tsconfig.json"),
        r#"{ "compilerOptions": { "strict": true } }"#,
    )
    .unwrap();

    // Create 505 packages (M5 exact limit is 500)
    for i in 0..=504 {
        let pkg_dir = repo.join(format!("packages/pkg_{:04}", i));
        fs::create_dir_all(pkg_dir.join("src")).unwrap();
        fs::create_dir_all(pkg_dir.join("tests")).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            format!(
                r#"{{ "name": "@my/pkg_{:04}", "scripts": {{ "test": "vitest" }} }}"#,
                i
            ),
        )
        .unwrap();
        fs::write(pkg_dir.join("src/index.ts"), "export const val = 1;").unwrap();
        fs::write(pkg_dir.join("tests/index.test.ts"), "test('v', () => {});").unwrap();
    }

    git_commit_all(repo, "initial 505 packages");

    // Modify root tsconfig
    fs::write(
        repo.join("tsconfig.json"),
        r#"{ "compilerOptions": { "strict": false } }"#,
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Must include test obligation for pkg_0500 (beyond exact M5 limit)
    let has_pkg_0500 = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("pkg_0500") || c.scope.contains("pkg_0500"));

    assert!(
        has_pkg_0500,
        "Package pkg_0500 (beyond exact M5 limit) must retain verification obligation"
    );
}
