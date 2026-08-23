//! Tests for independent fallback test inventory and safe conservative scope behavior.

use fdx::intelligence::testplan::bounds::{with_test_limits, TestPlanLimits};
use fdx::intelligence::testplan::discover::discover_tests_and_checks;
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::protocol::AssuranceLevel;
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
fn test_fallback_inventory_populates_safe_package_and_config_scopes() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();

    let pkg_dir = repo.join("packages/core");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/core", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pkg_dir.join("vitest.config.ts"),
        r#"export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });"#,
    )
    .unwrap();

    fs::write(pkg_dir.join("src/index.ts"), "export const c = 1;").unwrap();
    fs::write(pkg_dir.join("tests/index.test.ts"), "test('c', () => {});").unwrap();

    let inv = discover_tests_and_checks(repo);

    assert!(
        inv.fallback
            .package_test_scopes
            .contains(&"pkg:npm:packages/core".to_string()),
        "Fallback inventory must contain package test scope"
    );
}

#[test]
fn test_exact_and_fallback_incomplete_without_suite_yields_unverified() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pa = repo.join("packages/pa");
    let pb = repo.join("packages/pb");
    fs::create_dir_all(pa.join("src")).unwrap();
    fs::create_dir_all(pa.join("tests")).unwrap();
    fs::create_dir_all(pb.join("src")).unwrap();
    fs::create_dir_all(pb.join("tests")).unwrap();

    // No test script in package.json
    fs::write(pa.join("package.json"), r#"{ "name": "@my/pa" }"#).unwrap();
    fs::write(pb.join("package.json"), r#"{ "name": "@my/pb" }"#).unwrap();

    fs::write(pa.join("src/a.ts"), "export const a = 1;").unwrap();
    fs::write(pa.join("tests/a1.test.ts"), "test('a1', () => {});").unwrap();
    fs::write(pa.join("tests/a2.test.ts"), "test('a2', () => {});").unwrap();

    fs::write(pb.join("src/b.ts"), "export const b = 1;").unwrap();
    fs::write(pb.join("tests/b1.test.ts"), "test('b1', () => {});").unwrap();
    fs::write(pb.join("tests/b2.test.ts"), "test('b2', () => {});").unwrap();

    git_commit_all(repo, "initial");
    fs::write(pa.join("src/a.ts"), "export const a = 2;").unwrap();
    fs::write(pb.join("src/b.ts"), "export const b = 2;").unwrap();

    let tiny_limits = TestPlanLimits {
        max_discovered_tests: 1,
        max_fallback_boundaries: 1,
        ..Default::default()
    };

    with_test_limits(tiny_limits, || {
        let inv = discover_tests_and_checks(repo);
        assert!(inv.truncated, "Exact discovery must be truncated");
        assert!(
            inv.fallback.truncated,
            "Fallback inventory must be truncated"
        );

        let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");
        assert_eq!(
            plan.assurance,
            AssuranceLevel::Unverified,
            "Must be UNVERIFIED when both exact and fallback truncate without suite"
        );
        assert!(
            !plan.unresolved_obligations.is_empty(),
            "Must record typed unresolved verification obligations"
        );
    });
}

#[test]
fn test_exact_and_fallback_incomplete_with_suite_control_selects_enclosing_suite() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pa = repo.join("packages/pa");
    fs::create_dir_all(pa.join("src")).unwrap();
    fs::create_dir_all(pa.join("tests")).unwrap();

    // Package has test script
    fs::write(
        pa.join("package.json"),
        r#"{ "name": "@my/pa", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(pa.join("src/a.ts"), "export const a = 1;").unwrap();
    fs::write(pa.join("tests/a1.test.ts"), "test('a1', () => {});").unwrap();
    fs::write(pa.join("tests/a2.test.ts"), "test('a2', () => {});").unwrap();

    git_commit_all(repo, "initial");
    fs::write(pa.join("src/a.ts"), "export const a = 2;").unwrap();

    let tiny_limits = TestPlanLimits {
        max_discovered_tests: 1,
        max_fallback_boundaries: 1,
        ..Default::default()
    };

    with_test_limits(tiny_limits, || {
        let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");
        let has_suite = plan
            .selected_checks
            .iter()
            .any(|c| c.check_id == "check:pkg:npm:packages/pa:test");
        assert!(
            has_suite,
            "Enclosing package test suite script must be selected"
        );
        assert!(
            plan.unresolved_obligations.is_empty(),
            "No unresolved obligations when suite script exists"
        );
    });
}
