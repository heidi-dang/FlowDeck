//! Tests for test discovery failure handling, walker errors, read errors, and parse errors.

use fdx::intelligence::testplan::bounds::with_test_discovery_walker_error;
use fdx::intelligence::testplan::discover::discover_tests_and_checks;
use fdx::intelligence::testplan::model::DiscoveryState;
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::protocol::AssuranceLevel;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

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
fn test_discovery_walker_error_without_suite_yields_unverified_with_unresolved_obligation() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    init_git_repo(root);

    let pkg_dir = root.join("packages/nosuite");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    // No test script
    fs::write(pkg_dir.join("package.json"), r#"{"name": "@my/nosuite"}"#).unwrap();
    fs::write(pkg_dir.join("src/index.ts"), "export const a = 1;").unwrap();
    fs::write(pkg_dir.join("tests/index.test.ts"), "test('a', () => {});").unwrap();
    git_commit_all(root, "initial");

    fs::write(pkg_dir.join("src/index.ts"), "export const a = 2;").unwrap();

    let plan =
        with_test_discovery_walker_error(Some("Injected I/O walker failure".to_string()), || {
            plan_verification(root, Some("HEAD"), None, None).unwrap()
        });

    assert_eq!(
        plan.assurance,
        AssuranceLevel::Unverified,
        "Must be UNVERIFIED when discovery fails without enclosing suite"
    );
    assert!(
        !plan.unresolved_obligations.is_empty(),
        "Must record unresolved verification obligation"
    );
}

#[test]
fn test_discovery_walker_error_with_suite_retains_suite_check() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    init_git_repo(root);

    let pkg_dir = root.join("packages/withsuite");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{"name": "@my/withsuite", "scripts": {"test": "vitest"}}"#,
    )
    .unwrap();
    fs::write(pkg_dir.join("src/index.ts"), "export const a = 1;").unwrap();
    fs::write(pkg_dir.join("tests/index.test.ts"), "test('a', () => {});").unwrap();
    git_commit_all(root, "initial");

    fs::write(pkg_dir.join("src/index.ts"), "export const a = 2;").unwrap();

    let plan =
        with_test_discovery_walker_error(Some("Injected I/O walker failure".to_string()), || {
            plan_verification(root, Some("HEAD"), None, None).unwrap()
        });

    assert!(plan
        .selected_checks
        .iter()
        .any(|c| c.check_id == "check:pkg:npm:packages/withsuite:test"));
    assert!(plan.unresolved_obligations.is_empty());
}

#[test]
fn test_discovery_malformed_package_json_recorded_as_issue() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();

    fs::write(root.join("package.json"), "{ malformed json }").unwrap();

    let inv = discover_tests_and_checks(root);
    match inv.state {
        DiscoveryState::Incomplete { issues } => {
            assert!(issues
                .iter()
                .any(|i| i.kind == "parse_error" && i.path.as_deref() == Some("package.json")));
        }
        _ => panic!("Expected parse error on malformed package.json"),
    }
}
