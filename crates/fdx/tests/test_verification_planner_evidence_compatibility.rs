//! Tests for evidence edge compatibility with semantic provider state and fingerprint mismatch widening.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};

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
fn test_missing_provider_state_for_persisted_precise_edge_retains_edge_and_widens_package() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/pa");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/pa", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(pkg_dir.join("src/a.ts"), "export const a = 1;").unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Persist edge in DB, but DO NOT insert any record into semantic_providers
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pa/tests/a.test.ts', 'file', 'packages/pa/tests/a.test.ts', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:a', 'symbol', 'packages/pa/src/a.ts', 'a', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:a', 'references', 'scip_ts', 'fp_orphan', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-typescript')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(pkg_dir.join("src/a.ts"), "export const a = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // a.test.ts must be retained for positive conservative safety
    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "a.test.ts must be retained");

    // Package must widen to other.test.ts because provider state is missing
    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("other.test.ts"));
    assert!(
        other_test.is_some(),
        "Package must widen when edge provider state is missing"
    );
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact when edge has missing provider state"
    );
}

#[test]
fn test_fingerprint_mismatched_edge_retains_edge_and_widens_package() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/pa");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/pa", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(pkg_dir.join("src/a.ts"), "export const a = 1;").unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Persist provider state with FP_CURRENT, but edge with FP_OLD
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pa/tests/a.test.ts', 'file', 'packages/pa/tests/a.test.ts', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:a', 'symbol', 'packages/pa/src/a.ts', 'a', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-ts', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', '.', 'packages/pa', 'cfg_fp_current', 'fp_current_digest', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        // Edge has provider_fingerprint = "fp_old"
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:a', 'references', 'scip_ts', 'fp_old', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-ts')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(pkg_dir.join("src/a.ts"), "export const a = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // a.test.ts retained
    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "a.test.ts must be retained");

    // Package widens to other.test.ts
    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("other.test.ts"));
    assert!(
        other_test.is_some(),
        "Package must widen when edge fingerprint does not match current provider fingerprint"
    );
    assert!(
        plan.uncertainty
            .iter()
            .any(|u| u.code().contains("stale") || u.code().contains("provider")),
        "Uncertainty must be emitted for fingerprint mismatch"
    );
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact on fingerprint mismatch"
    );
}
