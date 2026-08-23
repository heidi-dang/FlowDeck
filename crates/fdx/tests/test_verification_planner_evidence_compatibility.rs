//! Tests for evidence edge compatibility with semantic provider state and fingerprint mismatch widening.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use fdx::intelligence::semantic::provider::{
    ProviderFingerprint, ProviderIdentity, ProviderScope, ProviderState, ProviderType,
};
use fdx::intelligence::semantic::LanguageId;
use fdx::intelligence::testplan::mapping::TestMappingEdge;
use fdx::intelligence::testplan::model::SelectionReason;
use fdx::intelligence::testplan::planner::{
    evaluate_edge_compatibility, plan_verification, provider_covers_package, EvidenceCompatibility,
};
use fdx::protocol::{AssuranceLevel, EdgeKind, EvidenceStrength};
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

#[test]
fn test_provider_id_spoof_fingerprint_is_incompatible_retains_edge_and_widens() {
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
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Provider has provider_id = "scip-typescript" and digest = "FULL_DIGEST_CURRENT_12345"
    // Edge has provider_id = "scip-typescript" and provider_fingerprint = "scip-typescript" (spoofed provider ID)
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
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0', '/bin/scip-typescript', '0.1', '["typescript"]', '.', 'packages/pa', 'cfg123', 'FULL_DIGEST_CURRENT_12345', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        // Edge provider_fingerprint is spoofed to equal provider_id
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', 'scip-typescript', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-typescript')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // 1. a.test.ts must be retained for positive conservative safety
    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "a.test.ts must be retained");
    assert_eq!(a_test.unwrap().selection, SelectionReason::Evidence);

    // 2. other.test.ts must be selected via package widening
    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("other.test.ts"));
    assert!(
        other_test.is_some(),
        "Package must widen when edge fingerprint is a provider-ID spoof"
    );

    // 3. Assurance must not be Exact
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact on provider-ID spoof"
    );
    assert!(
        plan.uncertainty
            .iter()
            .any(|u| u.code().contains("stale") || u.code().contains("provider")),
        "Fingerprint mismatch uncertainty must be recorded"
    );
}

#[test]
fn test_executable_identity_partial_fingerprint_is_incompatible_and_widens() {
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
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Provider has executable_identity = "EXEC123" and digest = "FULL_DIGEST_CURRENT_12345"
    // Edge has provider_fingerprint = "EXEC123" (executable identity component only)
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
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-ts', 'scip', '1.0', 'EXEC123', '0.1', '["typescript"]', '.', 'packages/pa', 'cfg123', 'FULL_DIGEST_CURRENT_12345', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        // Edge provider_fingerprint matches only the executable_identity component
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', 'EXEC123', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-ts')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "a.test.ts must be retained");

    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("other.test.ts"));
    assert!(
        other_test.is_some(),
        "Package must widen when edge fingerprint is only executable_identity"
    );
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact on partial executable identity match"
    );
}

#[test]
fn test_config_only_fingerprint_is_incompatible_and_widens() {
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
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Provider has config_fingerprint = "CFG123" and digest = "FULL_DIGEST_CURRENT_12345"
    // Edge has provider_fingerprint = "CFG123" (config fingerprint component only)
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
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-ts', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', '.', 'packages/pa', 'CFG123', 'FULL_DIGEST_CURRENT_12345', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        // Edge provider_fingerprint matches only the config_fingerprint component
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', 'CFG123', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-ts')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "a.test.ts must be retained");

    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("other.test.ts"));
    assert!(
        other_test.is_some(),
        "Package must widen when edge fingerprint is only config_fingerprint"
    );
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact on partial config component match"
    );
}

#[test]
fn test_exact_digest_control_is_compatible_and_narrows_precisely() {
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
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Provider has digest = FULL_DIGEST_CURRENT_12345, edge has provider_fingerprint = FULL_DIGEST_CURRENT_12345, stale = false
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
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-ts', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', '.', 'packages/pa', 'cfg123', 'FULL_DIGEST_CURRENT_12345', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', 'FULL_DIGEST_CURRENT_12345', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-ts')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // a.test.ts must be selected precisely
    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "a.test.ts must be selected");
    assert_eq!(a_test.unwrap().selection, SelectionReason::Evidence);
    assert_eq!(a_test.unwrap().strength, EvidenceStrength::Precise);

    // other.test.ts MUST NOT be selected
    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("other.test.ts"));
    assert!(
        other_test.is_none(),
        "other.test.ts must NOT be selected when exact fingerprint digest matches"
    );

    // Positive confirmation of direct evidence compatibility and narrowing
    assert!(
        plan.uncertainty
            .iter()
            .all(|u| !u.code().contains("fingerprint")),
        "No fingerprint mismatch uncertainty should be emitted"
    );
}

#[test]
fn test_missing_or_empty_fingerprint_is_incompatible_retains_edge_and_widens() {
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
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Edge has empty provider_fingerprint = ""
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
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-ts', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', '.', 'packages/pa', 'cfg123', 'FULL_DIGEST_CURRENT_12345', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        // Edge provider_fingerprint is empty string
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', '', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-ts')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "a.test.ts must be retained");

    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("other.test.ts"));
    assert!(
        other_test.is_some(),
        "Package must widen when edge fingerprint is empty/missing"
    );
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact on missing fingerprint"
    );
}

#[test]
fn test_real_provider_fingerprint_compute_config_mutation_invalidates_edge() {
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
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // FP1: computed with config CFG_A
    let fp1 = ProviderFingerprint::compute("1.0", "EXEC_A", "0.1", None, "CFG_A");
    // FP2: computed with config CFG_B (all other parameters identical)
    let fp2 = ProviderFingerprint::compute("1.0", "EXEC_A", "0.1", None, "CFG_B");

    assert_ne!(
        fp1.digest, fp2.digest,
        "Different configs must produce different full digests"
    );

    // Provider state persisted with FP2.digest
    // Edge persisted with FP1.digest (historical evidence before config change)
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
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-ts', 'scip', '1.0', 'EXEC_A', '0.1', '["typescript"]', '.', 'packages/pa', ?1, ?2, 'available', 'fresh', 1, 100, 100)"#,
                rusqlite::params![fp2.config_fingerprint, fp2.digest],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', ?1, 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-ts')",
                rusqlite::params![fp1.digest],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(
        a_test.is_some(),
        "a.test.ts must be retained for conservative positive safety"
    );

    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("other.test.ts"));
    assert!(
        other_test.is_some(),
        "Package must widen when semantic config mutation invalidated the historical fingerprint digest"
    );
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact when config mutation caused fingerprint mismatch"
    );
}

#[test]
fn test_provider_scope_ecosystem_isolation_between_cargo_and_npm() {
    let provider = ProviderState {
        identity: ProviderIdentity {
            provider_id: "scip-rust".to_string(),
            provider_type: ProviderType::Scip,
            provider_version: "1.0".to_string(),
            executable_identity: "/bin/rust-analyzer".to_string(),
            scip_schema_version: "0.1".to_string(),
        },
        scope: ProviderScope {
            workspace_root: ".".to_string(),
            package: Some("pkg:cargo:hybrid".to_string()),
            languages: vec![LanguageId::Rust],
        },
        fingerprint: ProviderFingerprint {
            provider_version: "1.0".to_string(),
            executable_identity: "/bin/rust-analyzer".to_string(),
            scip_schema_version: "0.1".to_string(),
            compiler_version: None,
            config_fingerprint: "cfg".to_string(),
            digest: "digest".to_string(),
        },
        health: ProviderHealth::Available,
        freshness: ProviderFreshness::Fresh,
        last_successful_run: Some(100),
        output_digest: None,
        failure_reason: None,
        semantic_generation: 1,
        last_attempt_fingerprint: None,
        last_attempt_at: None,
        last_attempt_health: None,
        last_attempt_failure_reason: None,
    };

    assert!(
        !provider_covers_package(&provider, "pkg:npm:hybrid"),
        "Provider with pkg:cargo:hybrid must NOT cover pkg:npm:hybrid"
    );
    assert!(
        provider_covers_package(&provider, "pkg:cargo:hybrid"),
        "Provider with pkg:cargo:hybrid must cover pkg:cargo:hybrid"
    );
}

#[test]
fn test_evaluate_edge_compatibility_direct_unit() {
    let state = ProviderState {
        identity: ProviderIdentity {
            provider_id: "scip-ts".to_string(),
            provider_type: ProviderType::Scip,
            provider_version: "1.0".to_string(),
            executable_identity: "EXEC_TS".to_string(),
            scip_schema_version: "0.1".to_string(),
        },
        scope: ProviderScope {
            workspace_root: "packages/pa".to_string(),
            package: Some("pkg:npm:packages/pa".to_string()),
            languages: vec![LanguageId::TypeScript],
        },
        fingerprint: ProviderFingerprint {
            provider_version: "1.0".to_string(),
            executable_identity: "EXEC_TS".to_string(),
            scip_schema_version: "0.1".to_string(),
            compiler_version: None,
            config_fingerprint: "CFG_TS".to_string(),
            digest: "DIGEST_FULL_MATCH".to_string(),
        },
        health: ProviderHealth::Available,
        freshness: ProviderFreshness::Fresh,
        last_successful_run: Some(100),
        output_digest: None,
        failure_reason: None,
        semantic_generation: 1,
        last_attempt_fingerprint: None,
        last_attempt_at: None,
        last_attempt_health: None,
        last_attempt_failure_reason: None,
    };

    let base_edge = TestMappingEdge {
        test_node: "file:packages/pa/tests/a.test.ts".to_string(),
        target_node: "sym:packages/pa/src/a.ts:a".to_string(),
        kind: EdgeKind::References,
        strength: EvidenceStrength::Precise,
        provider: "scip_ts".to_string(),
        provider_id: "scip-ts".to_string(),
        provider_fingerprint: Some("DIGEST_FULL_MATCH".to_string()),
        evidence_id: Some("ev1".to_string()),
        source_identity: Some("packages/pa/tests/a.test.ts".to_string()),
        stale: false,
    };

    // 1. Exact match -> Compatible
    assert_eq!(
        evaluate_edge_compatibility(
            &base_edge,
            Some(&state),
            "pkg:npm:packages/pa",
            Some(LanguageId::TypeScript),
        ),
        EvidenceCompatibility::Compatible
    );

    // 2. Provider ID spoof -> FingerprintMismatch
    let mut spoof_edge = base_edge.clone();
    spoof_edge.provider_fingerprint = Some("scip-ts".to_string());
    assert_eq!(
        evaluate_edge_compatibility(
            &spoof_edge,
            Some(&state),
            "pkg:npm:packages/pa",
            Some(LanguageId::TypeScript),
        ),
        EvidenceCompatibility::FingerprintMismatch
    );

    // 3. Executable component only -> FingerprintMismatch
    let mut exec_edge = base_edge.clone();
    exec_edge.provider_fingerprint = Some("EXEC_TS".to_string());
    assert_eq!(
        evaluate_edge_compatibility(
            &exec_edge,
            Some(&state),
            "pkg:npm:packages/pa",
            Some(LanguageId::TypeScript),
        ),
        EvidenceCompatibility::FingerprintMismatch
    );

    // 4. Config component only -> FingerprintMismatch
    let mut cfg_edge = base_edge.clone();
    cfg_edge.provider_fingerprint = Some("CFG_TS".to_string());
    assert_eq!(
        evaluate_edge_compatibility(
            &cfg_edge,
            Some(&state),
            "pkg:npm:packages/pa",
            Some(LanguageId::TypeScript),
        ),
        EvidenceCompatibility::FingerprintMismatch
    );

    // 5. Empty or missing fingerprint -> FingerprintMissing
    let mut missing_fp_edge = base_edge.clone();
    missing_fp_edge.provider_fingerprint = None;
    assert_eq!(
        evaluate_edge_compatibility(
            &missing_fp_edge,
            Some(&state),
            "pkg:npm:packages/pa",
            Some(LanguageId::TypeScript),
        ),
        EvidenceCompatibility::FingerprintMissing
    );

    // 6. Stale edge -> EdgeStale
    let mut stale_edge = base_edge.clone();
    stale_edge.stale = true;
    assert_eq!(
        evaluate_edge_compatibility(
            &stale_edge,
            Some(&state),
            "pkg:npm:packages/pa",
            Some(LanguageId::TypeScript),
        ),
        EvidenceCompatibility::EdgeStale
    );

    // 7. Missing provider -> MissingProvider
    assert_eq!(
        evaluate_edge_compatibility(
            &base_edge,
            None,
            "pkg:npm:packages/pa",
            Some(LanguageId::TypeScript),
        ),
        EvidenceCompatibility::MissingProvider
    );

    // 8. Scope mismatch -> ScopeMismatch
    assert_eq!(
        evaluate_edge_compatibility(
            &base_edge,
            Some(&state),
            "pkg:npm:packages/other",
            Some(LanguageId::TypeScript),
        ),
        EvidenceCompatibility::ScopeMismatch
    );

    // 9. Language mismatch -> LanguageMismatch
    assert_eq!(
        evaluate_edge_compatibility(
            &base_edge,
            Some(&state),
            "pkg:npm:packages/pa",
            Some(LanguageId::Rust),
        ),
        EvidenceCompatibility::LanguageMismatch
    );
}
