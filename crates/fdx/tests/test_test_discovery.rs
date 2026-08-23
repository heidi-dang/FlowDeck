//! Tests for static JS/TS and Rust test/check discovery without executing code.

use fdx::intelligence::testplan::discover::discover_tests_and_checks;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_discover_js_ts_test_files() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    fs::create_dir_all(root.join("packages/api/src")).unwrap();
    fs::create_dir_all(root.join("packages/api/tests")).unwrap();
    fs::create_dir_all(root.join("packages/api/__tests__")).unwrap();

    fs::write(
        root.join("packages/api/package.json"),
        r#"{
          "name": "@my/api",
          "scripts": {
            "test": "vitest",
            "typecheck": "tsc --noEmit",
            "lint": "eslint ."
          }
        }"#,
    )
    .unwrap();

    fs::write(root.join("packages/api/src/user.ts"), "export const u = 1;").unwrap();
    fs::write(
        root.join("packages/api/src/user.test.ts"),
        "test('user', () => {});",
    )
    .unwrap();
    fs::write(
        root.join("packages/api/tests/auth.spec.tsx"),
        "test('auth', () => {});",
    )
    .unwrap();
    fs::write(
        root.join("packages/api/__tests__/db.test.js"),
        "test('db', () => {});",
    )
    .unwrap();
    fs::write(
        root.join("packages/api/src/helper.ts"),
        "export const h = 2;",
    )
    .unwrap();

    let inventory = discover_tests_and_checks(root);

    assert!(!inventory.truncated);
    let test_ids: Vec<&str> = inventory
        .tests
        .iter()
        .map(|t| t.stable_id.as_str())
        .collect();
    assert!(test_ids
        .iter()
        .any(|id| id.ends_with("packages/api/src/user.test.ts")));
    assert!(test_ids
        .iter()
        .any(|id| id.ends_with("packages/api/tests/auth.spec.tsx")));
    assert!(test_ids
        .iter()
        .any(|id| id.ends_with("packages/api/__tests__/db.test.js")));
    assert!(!test_ids
        .iter()
        .any(|id| id.ends_with("packages/api/src/helper.ts")));

    // Static checks discovered from package.json
    let checks: Vec<&str> = inventory
        .checks
        .iter()
        .map(|c| c.check_id.as_str())
        .collect();
    assert!(checks.iter().any(|id| id.contains("typecheck")));
    assert!(checks.iter().any(|id| id.contains("lint")));
}

#[test]
fn test_discover_rust_cargo_tests() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();

    fs::create_dir_all(root.join("crates/core/src")).unwrap();
    fs::create_dir_all(root.join("crates/core/tests")).unwrap();
    fs::create_dir_all(root.join("crates/core/benches")).unwrap();

    fs::write(
        root.join("crates/core/Cargo.toml"),
        r#"[package]
name = "core"
version = "0.1.0"
edition = "2021"

[lib]
name = "core"
path = "src/lib.rs"
"#,
    )
    .unwrap();

    fs::write(
        root.join("crates/core/src/lib.rs"),
        "#[cfg(test)] mod tests {}",
    )
    .unwrap();
    fs::write(
        root.join("crates/core/tests/integration.rs"),
        "#[test] fn test_it() {}",
    )
    .unwrap();
    fs::write(
        root.join("crates/core/benches/bench_main.rs"),
        "fn bench() {}",
    )
    .unwrap();

    let inventory = discover_tests_and_checks(root);

    let test_ids: Vec<&str> = inventory
        .tests
        .iter()
        .map(|t| t.stable_id.as_str())
        .collect();
    assert!(test_ids
        .iter()
        .any(|id| id.ends_with("crates/core/tests/integration.rs")));
    assert!(test_ids
        .iter()
        .any(|id| id.contains("crates/core/src/lib.rs")));

    // Package checks discovered
    let checks: Vec<&str> = inventory
        .checks
        .iter()
        .map(|c| c.check_id.as_str())
        .collect();
    assert!(checks
        .iter()
        .any(|id| id.contains("cargo:crates/core") && id.contains("test")));
}
