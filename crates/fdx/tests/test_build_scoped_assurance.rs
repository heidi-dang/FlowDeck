//! Blocker 2: Scoped uncertainty preservation and non-degradation of unrelated scopes.

use fdx::cmd_build::build_refresh;
use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::intelligence::change::uncertainty::UncertaintyReason;
use fdx::protocol::AssuranceLevel;
use std::fs;
use std::path::Path;
use std::process::Command;

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
fn test_unrelated_malformed_package_does_not_degrade_valid_package_assurance() {
    // Control repository: pkg-a valid, pkg-b valid
    let control_dir = tempfile::tempdir().unwrap();
    let control_repo = control_dir.path();
    init_git_repo(control_repo);

    fs::write(
        control_repo.join("package.json"),
        serde_json::json!({ "name": "root", "private": true, "workspaces": ["packages/*"] })
            .to_string(),
    )
    .unwrap();
    let c_a = control_repo.join("packages/a");
    let c_b = control_repo.join("packages/b");
    fs::create_dir_all(c_a.join("src")).unwrap();
    fs::create_dir_all(c_b.join("src")).unwrap();
    fs::write(
        c_a.join("package.json"),
        serde_json::json!({ "name": "@app/a", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(c_a.join("src/index.ts"), "export const a = 1;").unwrap();
    fs::write(
        c_b.join("package.json"),
        serde_json::json!({ "name": "@app/b", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(c_b.join("src/index.ts"), "export const b = 1;").unwrap();
    git_commit_all(control_repo, "init");
    build_refresh(control_repo).unwrap();

    // Modify a in control
    fs::write(c_a.join("src/index.ts"), "export const a = 2;").unwrap();
    let control_result = analyze_impact_v2(control_repo, Some("HEAD"), None, Some(3)).unwrap();

    // Test repository: pkg-a valid, pkg-b MALFORMED and disconnected
    let test_dir = tempfile::tempdir().unwrap();
    let test_repo = test_dir.path();
    init_git_repo(test_repo);

    fs::write(
        test_repo.join("package.json"),
        serde_json::json!({ "name": "root", "private": true, "workspaces": ["packages/*"] })
            .to_string(),
    )
    .unwrap();
    let t_a = test_repo.join("packages/a");
    let t_b = test_repo.join("packages/b");
    fs::create_dir_all(t_a.join("src")).unwrap();
    fs::create_dir_all(t_b.join("src")).unwrap();
    fs::write(
        t_a.join("package.json"),
        serde_json::json!({ "name": "@app/a", "version": "1.0.0" }).to_string(),
    )
    .unwrap();
    fs::write(t_a.join("src/index.ts"), "export const a = 1;").unwrap();
    // Malformed package.json in b
    fs::write(
        t_b.join("package.json"),
        r#"{"name": "@app/b", MALFORMED_SYNTAX}"#,
    )
    .unwrap();
    fs::write(t_b.join("src/index.ts"), "export const b = 1;").unwrap();
    git_commit_all(test_repo, "init");
    // Refresh (package-json provider succeeds with scoped uncertainty for b)
    let _ = build_refresh(test_repo);

    // Modify a in test repo
    fs::write(t_a.join("src/index.ts"), "export const a = 2;").unwrap();
    let test_result = analyze_impact_v2(test_repo, Some("HEAD"), None, Some(3)).unwrap();

    // Expected:
    // 1. pkg-a result assurance identical to control repository
    assert_eq!(
        test_result.assurance, control_result.assurance,
        "pkg-a assurance must be identical to control repo despite unrelated pkg-b being malformed"
    );

    // 2. pkg-b uncertainty remains visible as a scoped diagnostic
    assert!(
        test_result
            .uncertainty
            .iter()
            .any(|u| matches!(u, UncertaintyReason::MalformedConfig(msg) if msg.contains("packages/b"))),
        "pkg-b malformed config uncertainty must remain visible as a scoped diagnostic in result.uncertainty"
    );
}

#[test]
fn test_build_provider_missing_and_failed_assurance_limiting() {
    let u_missing = UncertaintyReason::BuildProviderMissing("missing".to_string());
    let u_failed = UncertaintyReason::BuildProviderFailed("failed".to_string());

    assert_eq!(u_missing.limiting_assurance(), AssuranceLevel::Degraded);
    assert_eq!(u_failed.limiting_assurance(), AssuranceLevel::Degraded);
}
