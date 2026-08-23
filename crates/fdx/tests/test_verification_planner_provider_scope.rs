//! Tests for path-boundary correct provider workspace scope containment.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::semantic::provider::SemanticProvider;
use fdx::intelligence::semantic::scip::ts::ScipTypescriptProvider;
use fdx::intelligence::testplan::model::SelectionReason;
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::protocol::AssuranceLevel;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tempfile::tempdir;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    match ENV_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn create_mock_provider(dir: &Path) -> PathBuf {
    let bin = dir.join("mock-scip-ts");
    let script = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"scip-typescript 1.0.0\"; exit 0; fi\nexit 0\n";
    fs::write(&bin, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    }
    bin
}

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
fn test_provider_workspace_root_prefix_collision_does_not_cover_sibling() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pa = repo.join("packages/a");
    let pab = repo.join("packages/ab");
    fs::create_dir_all(pa.join("src")).unwrap();
    fs::create_dir_all(pa.join("tests")).unwrap();
    fs::create_dir_all(pab.join("src")).unwrap();
    fs::create_dir_all(pab.join("tests")).unwrap();

    fs::write(
        pa.join("package.json"),
        r#"{ "name": "@my/a", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pab.join("package.json"),
        r#"{ "name": "@my/ab", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(pa.join("src/a.ts"), "export const a = 1;").unwrap();
    fs::write(pa.join("tests/a.test.ts"), "test('a', () => {});").unwrap();

    fs::write(pab.join("src/b.ts"), "export const b = 1;").unwrap();
    fs::write(pab.join("tests/b.test.ts"), "test('b', () => {});").unwrap();
    fs::write(
        pab.join("tests/b_other.test.ts"),
        "test('b_other', () => {});",
    )
    .unwrap();

    // Persist provider rooted at "packages/a" with NO package field
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/ab/tests/b.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/ab/src/b.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/ab/tests/b.test.ts', 'file', 'packages/ab/tests/b.test.ts', 'pkg:npm:packages/ab')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/ab/src/b.ts:b', 'symbol', 'packages/ab/src/b.ts', 'b', 'pkg:npm:packages/ab')",
                [],
            )
            .unwrap();

        // Fresh provider rooted at packages/a
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-a', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', 'packages/a', NULL, 'cfg_a', 'fp_ab', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:b_test', 'file:packages/ab/tests/b.test.ts', 'sym:packages/ab/src/b.ts:b', 'references', 'scip_ts', 'fp_ab', 4, 'packages/ab/tests/b.test.ts', 'h1', 1, 1, 0, 'scip-a')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify packages/ab/src/b.ts
    fs::write(pab.join("src/b.ts"), "export const b = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Because packages/a DOES NOT cover packages/ab (prefix boundary!), packages/ab is uncovered -> package widens to b_other.test.ts
    let has_b_other = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("b_other.test.ts"));
    assert!(
        has_b_other,
        "packages/ab must NOT be covered by packages/a workspace_root prefix collision"
    );
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must not be Exact on uncovered scope"
    );
}

#[test]
fn test_provider_workspace_root_covers_subpackage() {
    let _lock = lock_env();
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let p_sub = repo.join("packages/a/sub");
    fs::create_dir_all(p_sub.join("src")).unwrap();
    fs::create_dir_all(p_sub.join("tests")).unwrap();

    fs::write(
        p_sub.join("package.json"),
        r#"{ "name": "@my/sub", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        p_sub.join("src/sub.ts"),
        "export function subFn() { return 1; }",
    )
    .unwrap();
    fs::write(p_sub.join("tests/sub.test.ts"), "test('sub', () => {});").unwrap();
    fs::write(
        p_sub.join("tests/sub_other.test.ts"),
        "test('sub_other', () => {});",
    )
    .unwrap();

    let bin_dir = tempdir().unwrap();
    let mock_bin = create_mock_provider(bin_dir.path());
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    let ts_provider = ScipTypescriptProvider::new();
    let fp = ts_provider.passive_fingerprint(repo, Some("1.0.0")).unwrap();

    // Persist provider rooted at "packages/a"
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/a/sub/tests/sub.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/a/sub/src/sub.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/a/sub/tests/sub.test.ts', 'file', 'packages/a/sub/tests/sub.test.ts', 'pkg:npm:packages/a/sub')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/a/sub/src/sub.ts:subFn', 'symbol', 'packages/a/sub/src/sub.ts', 'subFn', 'pkg:npm:packages/a/sub')",
                [],
            )
            .unwrap();

        // Fresh provider rooted at packages/a
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0.0', ?1, '0.1', '["typescript"]', 'packages/a', NULL, ?2, ?3, 'available', 'fresh', 1, 100, 100)"#,
                [&fp.executable_identity, &fp.config_fingerprint, &fp.digest],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:sub_test', 'file:packages/a/sub/tests/sub.test.ts', 'sym:packages/a/sub/src/sub.ts:subFn', 'references', 'scip_ts', ?1, 4, 'packages/a/sub/tests/sub.test.ts', 'h1', 1, 1, 0, 'scip-typescript')",
                [&fp.digest],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify packages/a/sub/src/sub.ts
    fs::write(
        p_sub.join("src/sub.ts"),
        "export function subFn() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let sub_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("sub.test.ts"));
    assert!(sub_test.is_some());
    assert_eq!(sub_test.unwrap().selection, SelectionReason::Evidence);
    let has_other = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("sub_other.test.ts"));
    assert!(
        !has_other,
        "packages/a/sub is correctly covered by packages/a provider root"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}
