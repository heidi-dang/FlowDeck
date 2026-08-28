//! Tests for static Jest/Vitest configuration support, roots, testRegex, and E2E test target widening.

use fdx::intelligence::testplan::discover::discover_tests_and_checks;
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
fn test_static_vitest_config_custom_include_discovered_and_selected() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/custom");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("qa")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/custom", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(
        pkg_dir.join("vitest.config.ts"),
        r#"export default defineConfig({
  test: {
    include: ["qa/**/*.case.ts"]
  }
});"#,
    )
    .unwrap();

    fs::write(pkg_dir.join("src/lib.ts"), "export const val = 1;").unwrap();
    fs::write(
        pkg_dir.join("qa/feature.case.ts"),
        "test('feature', () => {});",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    fs::write(pkg_dir.join("src/lib.ts"), "export const val = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let has_custom_case = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("feature.case.ts"));
    assert!(
        has_custom_case,
        "Static Vitest custom include pattern qa/**/*.case.ts must discover feature.case.ts"
    );
}

#[test]
fn test_static_jest_roots_configuration_registered_as_test_scope() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/qa-app");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("qa")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/qa-app", "scripts": { "test": "jest" } }"#,
    )
    .unwrap();

    fs::write(
        pkg_dir.join("jest.config.js"),
        r#"module.exports = {
  roots: ["<rootDir>/qa"]
};"#,
    )
    .unwrap();

    fs::write(pkg_dir.join("src/lib.ts"), "export const val = 1;").unwrap();
    fs::write(pkg_dir.join("qa/foo.test.ts"), "test('qa foo', () => {});").unwrap();

    let inv = discover_tests_and_checks(repo);

    let has_qa_scope = inv
        .fallback
        .directory_test_scopes
        .iter()
        .any(|s| s.contains("qa-app/qa") || s.contains("packages/qa-app/qa"));

    assert!(
        has_qa_scope,
        "Static Jest roots config '<rootDir>/qa' must be registered in fallback directory test scopes"
    );
}

#[test]
fn test_static_literal_test_regex_discovers_tests() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/regex-app");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("specs")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/regex-app", "scripts": { "test": "jest" } }"#,
    )
    .unwrap();

    fs::write(
        pkg_dir.join("jest.config.js"),
        r#"module.exports = {
  testRegex: "specs/.*\.spec\.ts$"
};"#,
    )
    .unwrap();

    fs::write(pkg_dir.join("src/lib.ts"), "export const val = 1;").unwrap();
    fs::write(
        pkg_dir.join("specs/my.spec.ts"),
        "test('regex spec', () => {});",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    fs::write(pkg_dir.join("src/lib.ts"), "export const val = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let has_spec = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("my.spec.ts"));
    assert!(
        has_spec,
        "Static literal testRegex in jest.config.js must discover specs/my.spec.ts"
    );
}

#[test]
fn test_e2e_only_package_widening_selects_e2e_check() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/e2e-app");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/e2e-app", "scripts": { "test:e2e": "playwright test" } }"#,
    )
    .unwrap();

    fs::write(pkg_dir.join("src/index.ts"), "export const app = 1;").unwrap();

    git_commit_all(repo, "initial");

    fs::write(pkg_dir.join("src/index.ts"), "export const app = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let has_e2e_check = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id == "check:pkg:npm:packages/e2e-app:test:e2e");
    assert!(
        has_e2e_check,
        "Conservative package widening must include EndToEndTest check when test:e2e is the package test target"
    );
}
