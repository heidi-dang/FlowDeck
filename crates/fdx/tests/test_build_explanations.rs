use fdx::intelligence::build::ingest::refresh_all_build_providers;
use fdx::intelligence::change::traverse::explain_why_target;
use std::fs;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn test_why_explanation_through_build_config_edges() {
    let dir = tempdir().unwrap();
    let root = dir.path();

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

    fs::write(
        root.join("tsconfig.base.json"),
        r#"{ "compilerOptions": { "target": "es2022" } }"#,
    )
    .unwrap();
    fs::write(
        root.join("package.json"),
        r#"{ "name": "root", "workspaces": ["packages/*"] }"#,
    )
    .unwrap();

    fs::create_dir_all(root.join("packages/web/src")).unwrap();
    fs::write(
        root.join("packages/web/package.json"),
        r#"{ "name": "@app/web", "version": "1.0.0" }"#,
    )
    .unwrap();
    fs::write(
        root.join("packages/web/tsconfig.json"),
        r#"{ "extends": "../../tsconfig.base.json" }"#,
    )
    .unwrap();
    fs::write(
        root.join("packages/web/src/index.ts"),
        "export const x = 1;",
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

    refresh_all_build_providers(root, false).unwrap();

    // Modify base config
    fs::write(
        root.join("tsconfig.base.json"),
        r#"{ "compilerOptions": { "target": "es2020" } }"#,
    )
    .unwrap();

    let why_res = explain_why_target(
        root,
        "packages/web/tsconfig.json",
        Some("HEAD"),
        None,
        Some(3),
    )
    .unwrap();
    assert!(why_res.is_some(), "why target must be found");
    let target = why_res.unwrap();
    assert!(target.primary_path.is_some());
    let path = target.primary_path.unwrap();
    assert!(
        path.explanation.contains("extends")
            || path.explanation.contains("configures")
            || path.explanation.contains("tsconfig")
    );
}
