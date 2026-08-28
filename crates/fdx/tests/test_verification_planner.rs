//! End-to-end verification planner tests.

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
fn test_plan_package_source_change_selects_tests_and_typecheck() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/calc/src")).unwrap();
    fs::create_dir_all(repo.join("packages/calc/tests")).unwrap();

    fs::write(
        repo.join("packages/calc/package.json"),
        r#"{
          "name": "@my/calc",
          "scripts": {
            "test": "vitest",
            "typecheck": "tsc --noEmit",
            "lint": "eslint ."
          }
        }"#,
    )
    .unwrap();

    fs::write(
        repo.join("packages/calc/src/add.ts"),
        "export const add = (a: number, b: number) => a + b;",
    )
    .unwrap();
    fs::write(
        repo.join("packages/calc/tests/add.test.ts"),
        "test('add', () => {});",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    // Modify add.ts
    fs::write(
        repo.join("packages/calc/src/add.ts"),
        "export const add = (a: number, b: number) => a + b + 0;",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    assert!(!plan.selected_checks.is_empty());
    // Both test and mandatory package checks (typecheck/lint) should be planned
    let has_test = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("add.test.ts") || c.check_id.contains("test"));
    let has_typecheck = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("typecheck"));
    assert!(has_test, "Test check should be selected");
    assert!(has_typecheck, "Typecheck check should be selected");
}

#[test]
fn test_plan_root_tsconfig_change_widens_to_all_ts_projects() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/a/src")).unwrap();
    fs::create_dir_all(repo.join("packages/b/src")).unwrap();

    fs::write(
        repo.join("tsconfig.json"),
        r#"{ "compilerOptions": { "strict": true } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("packages/a/package.json"),
        r#"{ "name": "@my/a", "scripts": { "typecheck": "tsc" } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("packages/b/package.json"),
        r#"{ "name": "@my/b", "scripts": { "typecheck": "tsc" } }"#,
    )
    .unwrap();
    fs::write(repo.join("packages/a/src/a.ts"), "export const a = 1;").unwrap();
    fs::write(repo.join("packages/b/src/b.ts"), "export const b = 2;").unwrap();

    git_commit_all(repo, "initial");

    // Modify root tsconfig
    fs::write(
        repo.join("tsconfig.json"),
        r#"{ "compilerOptions": { "strict": false } }"#,
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Both package a and b typechecks should be widened
    let has_a = plan
        .selected_checks
        .iter()
        .any(|c| c.scope.contains("packages/a") || c.check_id.contains("packages/a"));
    let has_b = plan
        .selected_checks
        .iter()
        .any(|c| c.scope.contains("packages/b") || c.check_id.contains("packages/b"));
    assert!(has_a, "Package A check should be selected");
    assert!(has_b, "Package B check should be selected");
}

#[test]
fn test_plan_cargo_workspace_crate_change() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("crates/foo/src")).unwrap();
    fs::create_dir_all(repo.join("crates/foo/tests")).unwrap();
    fs::create_dir_all(repo.join("crates/bar/src")).unwrap();

    fs::write(
        repo.join("Cargo.toml"),
        r#"[workspace]
members = ["crates/foo", "crates/bar"]
resolver = "2"
"#,
    )
    .unwrap();

    fs::write(
        repo.join("crates/foo/Cargo.toml"),
        r#"[package]
name = "foo"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(
        repo.join("crates/foo/src/lib.rs"),
        "pub fn foo_fn() -> i32 { 1 }",
    )
    .unwrap();
    fs::write(
        repo.join("crates/foo/tests/foo_test.rs"),
        "#[test] fn test_foo() {}",
    )
    .unwrap();

    fs::write(
        repo.join("crates/bar/Cargo.toml"),
        r#"[package]
name = "bar"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(
        repo.join("crates/bar/src/lib.rs"),
        "pub fn bar_fn() -> i32 { 2 }",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    // Modify only foo
    fs::write(
        repo.join("crates/foo/src/lib.rs"),
        "pub fn foo_fn() -> i32 { 10 }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let has_foo = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("crates/foo"));
    let has_bar = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("crates/bar"));

    assert!(has_foo, "foo tests/checks should be selected");
    assert!(!has_bar, "unrelated bar should not be selected");
}

#[test]
fn test_plan_disconnected_package_isolation() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/pkg_a/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg_a/tests")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg_b/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg_b/tests")).unwrap();

    fs::write(
        repo.join("packages/pkg_a/package.json"),
        r#"{ "name": "@my/a", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("packages/pkg_b/package.json"),
        r#"{ "name": "@my/b", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(repo.join("packages/pkg_a/src/a.ts"), "export const a = 1;").unwrap();
    fs::write(
        repo.join("packages/pkg_a/tests/a.test.ts"),
        "test('a', () => {});",
    )
    .unwrap();
    fs::write(repo.join("packages/pkg_b/src/b.ts"), "export const b = 1;").unwrap();
    fs::write(
        repo.join("packages/pkg_b/tests/b.test.ts"),
        "test('b', () => {});",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    // Modify only pkg_b
    fs::write(repo.join("packages/pkg_b/src/b.ts"), "export const b = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let selects_a = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("packages/pkg_a"));
    let selects_b = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("packages/pkg_b"));

    assert!(selects_b, "Modified pkg_b must be selected");
    assert!(!selects_a, "Disconnected pkg_a must NOT be selected");
}

#[test]
fn test_plan_no_tests_found_does_not_manufacture_tests() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/utils/src")).unwrap();
    fs::write(
        repo.join("packages/utils/package.json"),
        r#"{ "name": "@my/utils", "scripts": { "typecheck": "tsc" } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("packages/utils/src/math.ts"),
        "export const pi = 3.14;",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    fs::write(
        repo.join("packages/utils/src/math.ts"),
        "export const pi = 3.14159;",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // No test files exist in the repo -> planner must not manufacture fake test files
    let test_checks = plan
        .selected_checks
        .iter()
        .filter(|c| {
            matches!(
                c.kind,
                fdx::intelligence::testplan::model::VerificationCheckKind::UnitTest
                    | fdx::intelligence::testplan::model::VerificationCheckKind::IntegrationTest
            )
        })
        .count();
    assert_eq!(test_checks, 0, "Must not manufacture fake test files");

    // But typecheck can still be selected as a mandatory package check
    let typecheck_check = plan
        .selected_checks
        .iter()
        .find(|c| c.kind == fdx::intelligence::testplan::model::VerificationCheckKind::Typecheck);
    assert!(
        typecheck_check.is_some(),
        "Typecheck check should be selected"
    );
}
