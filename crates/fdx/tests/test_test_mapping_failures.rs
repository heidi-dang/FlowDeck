//! Tests for test mapping failures, DB errors, and error propagation.

use fdx::intelligence::build::snapshot::CurrentBuildSnapshot;
use fdx::intelligence::testplan::bounds::with_test_mapping_db_error;
use fdx::intelligence::testplan::discover::discover_tests_and_checks;
use fdx::intelligence::testplan::mapping::resolve_test_mappings;
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
fn test_mapping_db_error_recorded_and_fails_closed() {
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
    git_commit_all(root, "init");

    let inv = discover_tests_and_checks(root);
    let snapshot = CurrentBuildSnapshot::build(root);

    let res = with_test_mapping_db_error(Some("Injected DB disk error".to_string()), || {
        resolve_test_mappings(None, &snapshot, &inv)
    });

    assert!(res
        .errors
        .iter()
        .any(|e| e.contains("Injected DB disk error")));

    // Planner with mapping error emits uncertainty and ensures safe package widening
    let plan = with_test_mapping_db_error(Some("Injected DB disk error".to_string()), || {
        plan_verification(root, None, None, None).unwrap()
    });

    assert!(plan.uncertainty.iter().any(|u| u.code() == "graph_corrupt"));
    assert_ne!(plan.assurance, AssuranceLevel::Exact);
}
