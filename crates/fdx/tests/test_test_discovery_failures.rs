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
fn test_discovery_walker_error_recorded_and_fails_closed() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    init_git_repo(root);

    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join("tests")).unwrap();
    fs::write(
        root.join("package.json"),
        r#"{"name": "test-pkg", "scripts": {"test": "vitest"}}"#,
    )
    .unwrap();
    fs::write(root.join("src/index.ts"), "export const a = 1;").unwrap();
    fs::write(root.join("tests/index.test.ts"), "test('a', () => {});").unwrap();
    git_commit_all(root, "initial");

    // 1. Direct discovery with walker error
    let inv =
        with_test_discovery_walker_error(Some("Injected I/O walker failure".to_string()), || {
            discover_tests_and_checks(root)
        });

    match inv.state {
        DiscoveryState::Incomplete { issues } => {
            assert!(issues
                .iter()
                .any(|i| i.kind == "walker_error"
                    && i.message.contains("Injected I/O walker failure")));
        }
        _ => panic!("Expected DiscoveryState::Incomplete on walker error"),
    }

    // 2. Planner under walker error emits uncertainty and degrades assurance safely
    let plan =
        with_test_discovery_walker_error(Some("Injected I/O walker failure".to_string()), || {
            plan_verification(root, None, None, None).unwrap()
        });

    assert!(plan
        .uncertainty
        .iter()
        .any(|u| u.code() == "build_limit_reached" || u.code().contains("limit")));
    assert_ne!(plan.assurance, AssuranceLevel::Exact);
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
