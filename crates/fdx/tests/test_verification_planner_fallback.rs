//! Tests for independent fallback test inventory and safe conservative scope behavior.

use fdx::intelligence::testplan::discover::discover_tests_and_checks;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_fallback_inventory_populates_safe_package_and_config_scopes() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();

    let pkg_dir = repo.join("packages/core");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/core", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pkg_dir.join("vitest.config.ts"),
        r#"export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });"#,
    )
    .unwrap();

    fs::write(pkg_dir.join("src/index.ts"), "export const c = 1;").unwrap();
    fs::write(pkg_dir.join("tests/index.test.ts"), "test('c', () => {});").unwrap();

    let inv = discover_tests_and_checks(repo);

    assert!(
        inv.fallback
            .package_test_scopes
            .contains(&"pkg:npm:packages/core".to_string()),
        "Fallback inventory must contain package test scope"
    );
}
