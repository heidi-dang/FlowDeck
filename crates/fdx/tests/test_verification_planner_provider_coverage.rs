//! Tests for deterministic semantic provider language coverage and provider order independence.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::testplan::model::SelectionReason;
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
fn test_wrong_language_provider_does_not_satisfy_package_coverage() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/web");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/web", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }
export function fnOther() { return 2; }
",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Persist a fresh RUST provider covering packages/web, and a direct mapping edge for a.test.ts
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/web/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/web/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/web/tests/a.test.ts', 'file', 'packages/web/tests/a.test.ts', 'pkg:npm:packages/web')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/web/src/a.ts:fnA', 'symbol', 'packages/web/src/a.ts', 'fnA', 'pkg:npm:packages/web')",
                [],
            )
            .unwrap();

        // Fresh Rust provider covering packages/web
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-rust', 'scip', '1.0', 'scip-rust', '0.1', '["rust"]', '.', 'packages/web', 'cfg_rust', 'in_rust', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/web/tests/a.test.ts', 'sym:packages/web/src/a.ts:fnA', 'references', 'scip_rust', 'fp_rust', 4, 'packages/web/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-rust')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify a.ts
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 42; }
export function fnOther() { return 2; }
",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Rust provider MUST NOT satisfy TypeScript package coverage: package must widen to other.test.ts
    let has_other = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("other.test.ts") || c.check_id.contains("packages/web:test"));
    assert!(
        has_other,
        "Package must widen because Rust provider does not cover TypeScript package"
    );
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact when language is uncovered"
    );
}

#[test]
fn test_multi_language_package_requires_coverage_for_all_relevant_languages() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/poly");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/poly", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }",
    )
    .unwrap();
    fs::write(
        pkg_dir.join("src/b.js"),
        "export function fnB() { return 2; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(pkg_dir.join("tests/b.test.js"), "test('b', () => {});").unwrap();
    fs::write(pkg_dir.join("tests/c.test.ts"), "test('c', () => {});").unwrap();

    // 1. Only TypeScript provider exists
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/poly/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/poly/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/poly/tests/a.test.ts', 'file', 'packages/poly/tests/a.test.ts', 'pkg:npm:packages/poly')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/poly/src/a.ts:fnA', 'symbol', 'packages/poly/src/a.ts', 'fnA', 'pkg:npm:packages/poly')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-ts', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', '.', 'packages/poly', 'fp_ts', 'in_ts', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/poly/tests/a.test.ts', 'sym:packages/poly/src/a.ts:fnA', 'references', 'scip_ts', 'fp_ts', 4, 'packages/poly/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-ts')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify a.ts
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 42; }",
    )
    .unwrap();

    let plan1 = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");
    // JavaScript is uncovered in polyglot package -> package must widen
    let has_c = plan1
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("c.test.ts"));
    assert!(
        has_c,
        "Multi-language package missing JavaScript coverage must widen"
    );

    // 2. Now add JavaScript coverage as well
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-js', 'scip', '1.0', 'scip-js', '0.1', '["javascript"]', '.', 'packages/poly', 'cfg_js', 'in_js', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();
    }

    let plan2 = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");
    let a_test = plan2
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some());
    assert_eq!(a_test.unwrap().selection, SelectionReason::Evidence);
    // Unrelated c.test.ts must not be selected once all required languages are covered
    let has_c_now = plan2
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("c.test.ts"));
    assert!(
        !has_c_now,
        "When all languages are covered, unrelated c.test.ts is not selected"
    );
}

#[test]
fn test_provider_order_independence() {
    let tmp1 = tempdir().unwrap();
    let tmp2 = tempdir().unwrap();
    let repo1 = tmp1.path();
    let repo2 = tmp2.path();
    init_git_repo(repo1);
    init_git_repo(repo2);

    for repo in [repo1, repo2] {
        let pkg_dir = repo.join("packages/ord");
        fs::create_dir_all(pkg_dir.join("src")).unwrap();
        fs::create_dir_all(pkg_dir.join("tests")).unwrap();
        fs::write(
            pkg_dir.join("package.json"),
            r#"{ "name": "@my/ord", "scripts": { "test": "vitest" } }"#,
        )
        .unwrap();
        fs::write(pkg_dir.join("src/a.ts"), "export const a = 1;").unwrap();
        fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
        fs::write(
            pkg_dir.join("tests/other.test.ts"),
            "test('other', () => {});",
        )
        .unwrap();
    }

    // Repo1: Insert Rust (fresh) then TS (stale)
    {
        let db = EvidenceDatabase::open(repo1, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-rust', 'scip', '1.0', 'scip-rust', '0.1', '["rust"]', '.', 'packages/ord', 'cfg_rust', 'in_rust', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-ts', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', '.', 'packages/ord', 'cfg_ts', 'in_ts', 'available', 'stale', 1, 100, 100)"#,
                [],
            )
            .unwrap();
    }

    // Repo2: Insert TS (stale) then Rust (fresh)
    {
        let db = EvidenceDatabase::open(repo2, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-ts', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', '.', 'packages/ord', 'cfg_ts', 'in_ts', 'available', 'stale', 1, 100, 100)"#,
                [],
            )
            .unwrap();
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-rust', 'scip', '1.0', 'scip-rust', '0.1', '["rust"]', '.', 'packages/ord', 'cfg_rust', 'in_rust', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();
    }

    git_commit_all(repo1, "init");
    git_commit_all(repo2, "init");

    fs::write(repo1.join("packages/ord/src/a.ts"), "export const a = 2;").unwrap();
    fs::write(repo2.join("packages/ord/src/a.ts"), "export const a = 2;").unwrap();

    let plan1 = plan_verification(repo1, Some("HEAD"), None, None).expect("plan verification");
    let plan2 = plan_verification(repo2, Some("HEAD"), None, None).expect("plan verification");

    assert_eq!(
        plan1.assurance, plan2.assurance,
        "Assurance must be identical regardless of provider insertion order"
    );
    assert_eq!(
        plan1.selected_checks.len(),
        plan2.selected_checks.len(),
        "Selected checks count must be identical regardless of provider order"
    );
    for (c1, c2) in plan1
        .selected_checks
        .iter()
        .zip(plan2.selected_checks.iter())
    {
        assert_eq!(c1.check_id, c2.check_id);
        assert_eq!(c1.selection, c2.selection);
    }
}
