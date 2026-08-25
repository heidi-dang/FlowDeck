//! Tests for deterministic test config discovery failures and error recording.

use fdx::intelligence::testplan::bounds::with_test_config_walker_error;
use fdx::intelligence::testplan::discover::discover_tests_and_checks;
use fdx::intelligence::testplan::model::DiscoveryState;
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

#[test]
fn test_config_walker_error_recorded_and_makes_discovery_incomplete() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/cfg");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/cfg", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    with_test_config_walker_error(
        Some("Injected config walker permission denied".to_string()),
        || {
            let inv = discover_tests_and_checks(repo);
            match inv.state {
                DiscoveryState::Incomplete { ref issues } => {
                    let has_cfg_walker_err = issues.iter().any(|i| i.kind == "config_walker_error");
                    assert!(has_cfg_walker_err, "Must record config_walker_error issue");
                }
                _ => panic!("Expected DiscoveryState::Incomplete on config walker error"),
            }
        },
    );
}
