use fdx::intelligence::build::ingest::refresh_all_build_providers;
use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::protocol::AssuranceLevel;
use std::fs;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn test_package_local_malformed_config_does_not_degrade_unrelated_package() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Init git repo
    Command::new("git")
        .args(["init"])
        .current_dir(root)
        .output()
        .unwrap();
    Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(root)
        .output()
        .unwrap();
    Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(root)
        .output()
        .unwrap();

    // Root package.json
    fs::write(
        root.join("package.json"),
        r#"{ "name": "root", "workspaces": ["packages/*"] }"#,
    )
    .unwrap();

    // Package A (valid)
    fs::create_dir_all(root.join("packages/pkg-a/src")).unwrap();
    fs::write(root.join("packages/pkg-a/src/a.ts"), "export const a = 1;").unwrap();
    fs::write(
        root.join("packages/pkg-a/package.json"),
        r#"{ "name": "@app/a", "version": "1.0.0" }"#,
    )
    .unwrap();

    // Package B (unrelated, malformed config)
    fs::create_dir_all(root.join("packages/pkg-b/src")).unwrap();
    fs::write(root.join("packages/pkg-b/src/b.ts"), "export const b = 2;").unwrap();
    fs::write(
        root.join("packages/pkg-b/package.json"),
        r#"{ "name": "@app/b", MALFORMED"#,
    )
    .unwrap();

    Command::new("git")
        .args(["add", "."])
        .current_dir(root)
        .output()
        .unwrap();
    Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(root)
        .output()
        .unwrap();

    refresh_all_build_providers(root, false).ok();

    // Modify pkg-a only
    fs::write(root.join("packages/pkg-a/src/a.ts"), "export const a = 2;").unwrap();

    let impact = analyze_impact_v2(root, Some("HEAD"), None, Some(3)).unwrap();

    // Analysis for pkg-a must proceed without global degradation
    let has_pkg_a = impact.impacted.iter().any(|t| t.target.contains("pkg-a"));
    assert!(has_pkg_a, "pkg-a must be impacted");

    // Scoped uncertainty must exist for pkg-b, but NOT cause repository-wide Unverified
    let pkg_b_scoped_unc = impact.uncertainty.iter().find(|u| {
        let code = u.code();
        code.contains("build") || code.contains("config") || format!("{:?}", u).contains("pkg-b")
    });
    assert!(
        pkg_b_scoped_unc.is_some(),
        "must have scoped uncertainty for pkg-b"
    );

    // The assurance must not degrade globally to Unverified solely due to unrelated pkg-b malformed config
    assert_ne!(impact.assurance, AssuranceLevel::Unverified);
}
