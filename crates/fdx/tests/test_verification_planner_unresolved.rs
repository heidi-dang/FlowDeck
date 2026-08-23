//! Tests for explicit UnresolvedVerificationObligation and fail-closed safety under bounds.

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
fn test_unresolved_obligation_generated_when_discovery_truncates_without_suite() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/unresolved-pkg");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/unresolved-pkg" }"#,
    )
    .unwrap();

    fs::write(pkg_dir.join("src/index.ts"), "export const x = 1;").unwrap();
    for i in 0..5 {
        fs::write(
            pkg_dir.join(format!("tests/test_{}.test.ts", i)),
            "test('x', () => {});",
        )
        .unwrap();
    }

    git_commit_all(repo, "initial");
    fs::write(pkg_dir.join("src/index.ts"), "export const x = 2;").unwrap();

    let _guard = set_test_limits_override(TestPlanLimits {
        max_discovered_tests: 2,
        max_mapping_edges: 50,
        max_selected_checks: 50,
        max_fallback_boundaries: 50,
    });

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    assert_eq!(plan.assurance, AssuranceLevel::Unverified);
    assert!(!plan.unresolved_obligations.is_empty());
    assert_eq!(plan.unresolved_obligations[0].source, "discovery_limit");
    assert_eq!(
        plan.unresolved_obligations[0].scope,
        "pkg:npm:packages/unresolved-pkg"
    );
}
