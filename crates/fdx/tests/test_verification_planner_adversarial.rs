//! Adversarial test cases for verification planner.

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
fn test_dynamic_js_test_config_creates_uncertainty_and_widens_safely() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/dyn/src")).unwrap();
    fs::create_dir_all(repo.join("packages/dyn/tests")).unwrap();

    fs::write(
        repo.join("packages/dyn/package.json"),
        r#"{ "name": "@my/dyn", "scripts": { "test": "vitest run" } }"#,
    )
    .unwrap();
    // Dynamic vitest config requiring arbitrary JS execution / environment
    fs::write(
        repo.join("packages/dyn/vitest.config.ts"),
        r#"import { defineConfig } from 'vitest/config';
export default defineConfig(() => {
  const dynamicInclude = process.env.TEST_SUITE === 'e2e' ? ['e2e/**/*.ts'] : ['tests/**/*.ts'];
  return { test: { include: dynamicInclude } };
});
"#,
    )
    .unwrap();
    fs::write(repo.join("packages/dyn/src/calc.ts"), "export const c = 1;").unwrap();
    fs::write(
        repo.join("packages/dyn/tests/calc.test.ts"),
        "test('calc', () => {});",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    // Modify calc.ts
    fs::write(repo.join("packages/dyn/src/calc.ts"), "export const c = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Must not execute vitest config; must record dynamic config uncertainty
    let has_dynamic_unc = plan.uncertainty.iter().any(|u| {
        let code = u.code();
        code.contains("dynamic") || code.contains("config")
    });
    assert!(
        has_dynamic_unc,
        "Must emit uncertainty for dynamic test config"
    );

    // Widens safely to package test target
    let has_pkg_test = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("packages/dyn"));
    assert!(has_pkg_test, "Must widen to package test checks");
}

#[test]
fn test_cyclic_package_references_do_not_hang_planner() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    // pkg A depends on B, pkg B depends on A
    fs::create_dir_all(repo.join("packages/pkg_a/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg_b/src")).unwrap();

    fs::write(
        repo.join("packages/pkg_a/package.json"),
        r#"{ "name": "@my/a", "dependencies": { "@my/b": "workspace:*" }, "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("packages/pkg_b/package.json"),
        r#"{ "name": "@my/b", "dependencies": { "@my/a": "workspace:*" }, "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(repo.join("packages/pkg_a/src/a.ts"), "export const a = 1;").unwrap();
    fs::write(repo.join("packages/pkg_b/src/b.ts"), "export const b = 1;").unwrap();

    git_commit_all(repo, "initial");

    fs::write(repo.join("packages/pkg_a/src/a.ts"), "export const a = 2;").unwrap();

    // Must terminate quickly without hanging or stack overflow
    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");
    assert!(!plan.selected_checks.is_empty());
}
