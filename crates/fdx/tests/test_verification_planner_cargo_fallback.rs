//! Tests for Cargo fallback package identity and hybrid npm/Cargo ownership.

use fdx::intelligence::build::bounds::{with_test_build_limits, BuildLimits};
use fdx::intelligence::build::snapshot::CurrentBuildSnapshot;
use fdx::intelligence::testplan::discover::{
    discover_tests_and_checks, fallback_scope_ids_for_dir,
};
use fdx::intelligence::testplan::planner::plan_verification;
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
fn test_cargo_fallback_package_when_omitted_from_exact_m5_ownership() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let ca = repo.join("crates/a");
    let cb = repo.join("crates/b");
    fs::create_dir_all(ca.join("src")).unwrap();
    fs::create_dir_all(cb.join("src")).unwrap();
    fs::create_dir_all(cb.join("tests")).unwrap();

    fs::write(
        repo.join("Cargo.toml"),
        r#"[workspace]
members = ["crates/a", "crates/b"]
"#,
    )
    .unwrap();

    fs::write(
        ca.join("Cargo.toml"),
        r#"[package]
name = "crate-a"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(ca.join("src/lib.rs"), "pub fn fn_a() {}").unwrap();

    fs::write(
        cb.join("Cargo.toml"),
        r#"[package]
name = "crate-b"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(cb.join("src/lib.rs"), "pub fn fn_b() {}").unwrap();
    fs::write(
        cb.join("tests/b_test.rs"),
        "#[test]
fn test_b() { assert_eq!(1, 1); }",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    // Force M5 build limits: packages = 1 so crate B is omitted from exact snapshot
    let limits = BuildLimits {
        packages: 1,
        ..Default::default()
    };

    with_test_build_limits(limits, || {
        let snapshot = CurrentBuildSnapshot::build(repo);
        // Explicitly assert B is omitted from exact contains_file_to_packages
        assert!(
            !snapshot
                .contains_file_to_packages
                .contains_key("crates/b/tests/b_test.rs"),
            "crates/b must be omitted from exact M5 snapshot under packages=1 limit"
        );

        // M6 discovery must still discover b_test.rs and assign pkg:cargo:crates/b via fallback
        let inv = discover_tests_and_checks(repo);
        let b_test = inv
            .tests
            .iter()
            .find(|t| t.canonical_path.contains("b_test.rs"))
            .expect("b_test.rs found in discovery");
        assert_eq!(
            b_test.owning_package_id.as_deref(),
            Some("pkg:cargo:crates/b"),
            "Fallback ownership must be pkg:cargo:crates/b, not pkg:npm"
        );

        fs::write(cb.join("src/lib.rs"), "pub fn fn_b() { /* modified */ }").unwrap();
        let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

        // Cargo verification check must be retained
        let has_cargo_check = plan
            .selected_checks
            .iter()
            .any(|c| c.scope == "pkg:cargo:crates/b");
        assert!(
            has_cargo_check,
            "Cargo verification check for crates/b must be selected under fallback"
        );
    });
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
