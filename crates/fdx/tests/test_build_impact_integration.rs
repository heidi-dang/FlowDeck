use fdx::intelligence::build::ingest::refresh_all_build_providers;
use fdx::intelligence::change::traverse::analyze_impact_v2;
use std::fs;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn test_shared_tsconfig_base_change_impacts_all_extending_packages() {
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

    // Root tsconfig
    fs::write(
        root.join("tsconfig.base.json"),
        r#"{ "compilerOptions": { "target": "es2022" } }"#,
    )
    .unwrap();

    // Root package.json
    fs::write(
        root.join("package.json"),
        r#"{ "name": "root", "workspaces": ["packages/*"] }"#,
    )
    .unwrap();

    // Package A
    fs::create_dir_all(root.join("packages/pkg-a/src")).unwrap();
    fs::write(
        root.join("packages/pkg-a/package.json"),
        r#"{ "name": "@app/a", "version": "1.0.0" }"#,
    )
    .unwrap();
    fs::write(
        root.join("packages/pkg-a/tsconfig.json"),
        r#"{ "extends": "../../tsconfig.base.json" }"#,
    )
    .unwrap();
    fs::write(root.join("packages/pkg-a/src/a.ts"), "export const a = 1;").unwrap();

    // Package B
    fs::create_dir_all(root.join("packages/pkg-b/src")).unwrap();
    fs::write(
        root.join("packages/pkg-b/package.json"),
        r#"{ "name": "@app/b", "version": "1.0.0" }"#,
    )
    .unwrap();
    fs::write(
        root.join("packages/pkg-b/tsconfig.json"),
        r#"{ "extends": "../../tsconfig.base.json" }"#,
    )
    .unwrap();
    fs::write(root.join("packages/pkg-b/src/b.ts"), "export const b = 2;").unwrap();

    // Rust crate (unrelated)
    fs::create_dir_all(root.join("crates/rust-crate/src")).unwrap();
    fs::write(
        root.join("crates/rust-crate/Cargo.toml"),
        r#"[package]
name = "rust_crate"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(root.join("crates/rust-crate/src/lib.rs"), "pub fn r() {}").unwrap();

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

    // Change tsconfig.base.json
    fs::write(
        root.join("tsconfig.base.json"),
        r#"{ "compilerOptions": { "target": "es2020" } }"#,
    )
    .unwrap();

    let impact = analyze_impact_v2(root, Some("HEAD"), None, Some(3)).unwrap();

    let targets: Vec<_> = impact.impacted.iter().map(|t| t.target.as_str()).collect();

    // tsconfig.base.json must impact pkg-a and pkg-b
    assert!(
        targets.iter().any(|t| t.contains("packages/pkg-a")),
        "pkg-a must be impacted"
    );
    assert!(
        targets.iter().any(|t| t.contains("packages/pkg-b")),
        "pkg-b must be impacted"
    );

    // Unrelated Rust crate must NOT be impacted
    assert!(
        !targets.iter().any(|t| t.contains("crates/rust-crate")),
        "unrelated rust-crate must not be impacted"
    );
}
