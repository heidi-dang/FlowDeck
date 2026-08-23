//! Tests for build-transitive package impact obligation preservation under fresh semantic DB.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
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
fn test_build_transitive_package_impact_retains_test_obligation_with_fresh_core_semantic_db() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let core_dir = repo.join("packages/core");
    let app_dir = repo.join("packages/app");
    fs::create_dir_all(core_dir.join("src")).unwrap();
    fs::create_dir_all(core_dir.join("tests")).unwrap();
    fs::create_dir_all(app_dir.join("src")).unwrap();
    fs::create_dir_all(app_dir.join("tests")).unwrap();

    fs::write(
        core_dir.join("package.json"),
        r#"{ "name": "@my/core", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        app_dir.join("package.json"),
        r#"{ "name": "@my/app", "dependencies": { "@my/core": "workspace:*" }, "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(
        core_dir.join("src/index.ts"),
        "export function coreFn() { return 1; }",
    )
    .unwrap();
    fs::write(
        core_dir.join("tests/core.test.ts"),
        "test('core', () => {});",
    )
    .unwrap();

    fs::write(
        app_dir.join("src/main.ts"),
        "import { coreFn } from '@my/core'; export function appFn() { return coreFn(); }",
    )
    .unwrap();
    fs::write(
        app_dir.join("tests/main.test.ts"),
        "test('main', () => {});",
    )
    .unwrap();

    // Persist fresh provider covering ONLY package core
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/core/tests/core.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/core/src/index.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/core/tests/core.test.ts', 'file', 'packages/core/tests/core.test.ts', 'pkg:npm:packages/core')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/core/src/index.ts:coreFn', 'symbol', 'packages/core/src/index.ts', 'coreFn', 'pkg:npm:packages/core')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at) VALUES ('scip-core', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', '.', 'packages/core', 'cfg_core', 'in_core', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:core_test', 'file:packages/core/tests/core.test.ts', 'sym:packages/core/src/index.ts:coreFn', 'references', 'scip_ts', 'fp_core', 4, 'packages/core/tests/core.test.ts', 'h1', 1, 1, 0, 'scip-typescript')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Only modify core/src/index.ts
    fs::write(
        core_dir.join("src/index.ts"),
        "export function coreFn() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Core test must be selected
    let has_core_test = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("core"));
    assert!(has_core_test, "Core test must be selected");

    // App test obligation MUST be retained (either via app test check or package test check)
    let has_app_check = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("packages/app"));
    assert!(
        has_app_check,
        "App verification obligation must NOT disappear even though core semantic DB is fresh"
    );
}
