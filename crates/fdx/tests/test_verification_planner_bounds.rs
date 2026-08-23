//! Tests for test discovery and mapping bounds with safe fail-closed widening.

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
fn test_discovery_bound_truncation_escalates_and_widens() {
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

    // Set max_discovered_tests = 2
    let _guard = set_test_limits_override(TestPlanLimits {
        max_discovered_tests: 2,
        max_mapping_edges: 50,
        max_selected_checks: 100,
        max_fallback_boundaries: 50,
    });

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Bound truncation must degrade assurance and emit uncertainty
    assert!(
        plan.assurance <= AssuranceLevel::Degraded,
        "Assurance must be <= Degraded when discovery is truncated"
    );
    assert!(
        plan.uncertainty
            .iter()
            .any(|u| u.code().contains("limit") || u.code().contains("truncat")),
        "Must report limit/truncation uncertainty"
    );
}
