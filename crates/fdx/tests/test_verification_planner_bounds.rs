//! Tests for test discovery, mapping, and selected checks bounds with safe fail-closed widening.

use fdx::intelligence::testplan::bounds::{set_test_limits_override, TestPlanLimits};
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
fn test_discovery_bound_truncation_without_suite_script_yields_unverified_with_unresolved_obligation(
) {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/pkg/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg/tests")).unwrap();

    // No test script in package.json
    fs::write(
        repo.join("packages/pkg/package.json"),
        r#"{ "name": "@my/pkg" }"#,
    )
    .unwrap();

    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 1;").unwrap();
    for i in 0..6 {
        fs::write(
            repo.join(format!("packages/pkg/tests/test_{}.test.ts", i)),
            "test('t', () => {});",
        )
        .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 2;").unwrap();

    // Set max_discovered_tests = 2
    let _guard = set_test_limits_override(TestPlanLimits {
        max_discovered_tests: 2,
        max_mapping_edges: 50,
        max_selected_checks: 100,
        max_fallback_boundaries: 50,
    });

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    assert_eq!(
        plan.assurance,
        AssuranceLevel::Unverified,
        "Assurance must be Unverified when discovery truncates without enclosing suite script"
    );
    assert!(
        !plan.unresolved_obligations.is_empty(),
        "Must record typed unresolved obligation for truncated package"
    );
    assert_eq!(plan.unresolved_obligations[0].scope, "pkg:npm:packages/pkg");
}

#[test]
fn test_discovery_bound_truncation_with_package_script_retains_package_suite_obligation() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/pkg/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg/tests")).unwrap();

    fs::write(
        repo.join("packages/pkg/package.json"),
        r#"{ "name": "@my/pkg", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 1;").unwrap();
    for i in 0..6 {
        fs::write(
            repo.join(format!("packages/pkg/tests/test_{}.test.ts", i)),
            "test('t', () => {});",
        )
        .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 2;").unwrap();

    // Set max_discovered_tests = 2
    let _guard = set_test_limits_override(TestPlanLimits {
        max_discovered_tests: 2,
        max_mapping_edges: 50,
        max_selected_checks: 100,
        max_fallback_boundaries: 50,
    });

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Must include package test suite check
    assert!(plan
        .selected_checks
        .iter()
        .any(|c| c.check_id == "check:pkg:npm:packages/pkg:test"));
    assert!(plan.unresolved_obligations.is_empty());
}

#[test]
fn test_selected_checks_bound_with_no_enclosing_package_script_yields_unverified() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/pkg/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg/tests")).unwrap();

    // No "test" script in package.json
    fs::write(
        repo.join("packages/pkg/package.json"),
        r#"{ "name": "@my/pkg" }"#,
    )
    .unwrap();

    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 1;").unwrap();
    for i in 0..5 {
        fs::write(
            repo.join(format!("packages/pkg/tests/test_{}.test.ts", i)),
            "test('t', () => {});",
        )
        .unwrap();
    }

    git_commit_all(repo, "initial");
    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 2;").unwrap();

    // Set max_selected_checks = 2
    let _guard = set_test_limits_override(TestPlanLimits {
        max_discovered_tests: 100,
        max_mapping_edges: 100,
        max_selected_checks: 2,
        max_fallback_boundaries: 100,
    });

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Output cap exceeded and no package script to safely represent individual tests -> must be UNVERIFIED
    assert_eq!(plan.assurance, AssuranceLevel::Unverified);
    assert!(!plan.unresolved_obligations.is_empty());
}

#[test]
fn test_selected_checks_bound_with_package_script_rolls_up_to_package_suite() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/pkg/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg/tests")).unwrap();

    // Has "test" script
    fs::write(
        repo.join("packages/pkg/package.json"),
        r#"{ "name": "@my/pkg", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 1;").unwrap();
    for i in 0..5 {
        fs::write(
            repo.join(format!("packages/pkg/tests/test_{}.test.ts", i)),
            "test('t', () => {});",
        )
        .unwrap();
    }

    git_commit_all(repo, "initial");
    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 2;").unwrap();

    // Set max_selected_checks = 2
    let _guard = set_test_limits_override(TestPlanLimits {
        max_discovered_tests: 100,
        max_mapping_edges: 100,
        max_selected_checks: 2,
        max_fallback_boundaries: 100,
    });

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Must safely roll up to package-level check
    assert!(plan
        .selected_checks
        .iter()
        .any(|c| c.check_id == "check:pkg:npm:packages/pkg:test"));
    assert!(plan.selected_checks.len() <= 2);
}

#[test]
fn test_mapping_edge_bound_enforced() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/pkg/src")).unwrap();
    fs::create_dir_all(repo.join("packages/pkg/tests")).unwrap();

    fs::write(
        repo.join("packages/pkg/package.json"),
        r#"{ "name": "@my/pkg", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 1;").unwrap();
    for i in 0..10 {
        fs::write(
            repo.join(format!("packages/pkg/tests/test_{}.test.ts", i)),
            "test('t', () => {});",
        )
        .unwrap();
    }

    git_commit_all(repo, "initial");
    fs::write(repo.join("packages/pkg/src/a.ts"), "export const a = 2;").unwrap();

    // Set max_mapping_edges = 1
    let _guard = set_test_limits_override(TestPlanLimits {
        max_discovered_tests: 100,
        max_mapping_edges: 1,
        max_selected_checks: 100,
        max_fallback_boundaries: 100,
    });

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Mapping truncation causes conservative package widening
    assert!(
        plan.uncertainty.iter().any(|u| u.code().contains("limit")),
        "Must report mapping limit uncertainty"
    );
}
