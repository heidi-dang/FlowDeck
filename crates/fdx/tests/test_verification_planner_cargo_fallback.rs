//! Tests for Cargo fallback package identity and hybrid npm/Cargo ownership.

use fdx::intelligence::testplan::discover::{
    discover_tests_and_checks, fallback_scope_ids_for_dir,
};
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
fn test_cargo_fallback_package_identity_and_rust_test_ownership() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let crate_dir = repo.join("crates/my-crate");
    fs::create_dir_all(crate_dir.join("src")).unwrap();
    fs::create_dir_all(crate_dir.join("tests")).unwrap();

    fs::write(
        crate_dir.join("Cargo.toml"),
        r#"[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();

    fs::write(
        crate_dir.join("src/lib.rs"),
        "pub fn add(a: i32, b: i32) -> i32 { a + b }",
    )
    .unwrap();
    fs::write(
        crate_dir.join("tests/crate_test.rs"),
        "#[test]
fn test_add() { assert_eq!(2, 2); }",
    )
    .unwrap();

    let scopes = fallback_scope_ids_for_dir(repo, "crates/my-crate");
    assert_eq!(scopes, vec!["pkg:cargo:crates/my-crate".to_string()]);

    let inv = discover_tests_and_checks(repo);
    let test_item = inv
        .tests
        .iter()
        .find(|t| t.canonical_path.contains("crate_test.rs"))
        .expect("crate_test.rs found");
    assert_eq!(
        test_item.owning_package_id.as_deref(),
        Some("pkg:cargo:crates/my-crate")
    );
}

#[test]
fn test_hybrid_directory_assigns_cargo_to_rust_and_npm_to_js() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let hybrid = repo.join("hybrid");
    fs::create_dir_all(hybrid.join("src")).unwrap();
    fs::create_dir_all(hybrid.join("tests")).unwrap();

    fs::write(
        hybrid.join("Cargo.toml"),
        r#"[package]
name = "hybrid-native"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(
        hybrid.join("package.json"),
        r#"{ "name": "@my/hybrid-js", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(hybrid.join("src/lib.rs"), "pub fn rust_fn() {}").unwrap();
    fs::write(hybrid.join("src/index.ts"), "export function jsFn() {}").unwrap();
    fs::write(
        hybrid.join("tests/rust_test.rs"),
        "#[test]
fn t() {}",
    )
    .unwrap();
    fs::write(
        hybrid.join("tests/js_test.test.ts"),
        "test('js', () => {});",
    )
    .unwrap();

    let scopes = fallback_scope_ids_for_dir(repo, "hybrid");
    assert!(scopes.contains(&"pkg:cargo:hybrid".to_string()));
    assert!(scopes.contains(&"pkg:npm:hybrid".to_string()));

    let inv = discover_tests_and_checks(repo);
    let rust_test = inv
        .tests
        .iter()
        .find(|t| t.canonical_path.contains("rust_test.rs"))
        .expect("rust_test found");
    assert_eq!(
        rust_test.owning_package_id.as_deref(),
        Some("pkg:cargo:hybrid")
    );

    let js_test = inv
        .tests
        .iter()
        .find(|t| t.canonical_path.contains("js_test.test.ts"))
        .expect("js_test found");
    assert_eq!(js_test.owning_package_id.as_deref(), Some("pkg:npm:hybrid"));
}
