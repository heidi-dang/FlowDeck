//! Tests for scoped freshness isolation across packages in the verification planner.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::semantic::provider::SemanticProvider;
use fdx::intelligence::semantic::scip::ts::ScipTypescriptProvider;
use fdx::intelligence::testplan::model::SelectionReason;
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::protocol::EvidenceStrength;
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
fn test_simultaneous_stale_a_and_fresh_b_isolates_widening_to_a() {
    let _lock = lock_env();
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pa = repo.join("packages/pa");
    let pb = repo.join("packages/pb");
    fs::create_dir_all(pa.join("src")).unwrap();
    fs::create_dir_all(pa.join("tests")).unwrap();
    fs::create_dir_all(pb.join("src")).unwrap();
    fs::create_dir_all(pb.join("tests")).unwrap();

    fs::write(
        pa.join("package.json"),
        r#"{ "name": "@my/pa", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pb.join("package.json"),
        r#"{ "name": "@my/pb", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(
        pa.join("src/a.ts"),
        "export function fnA() { return 1; }",
    )
    .unwrap();
    fs::write(pa.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pa.join("tests/a_other.test.ts"),
        "test('a_other', () => {});",
    )
    .unwrap();

    fs::write(
        pb.join("src/b.ts"),
        "export function fnB() { return 1; }",
    )
    .unwrap();
    fs::write(pb.join("tests/b.test.ts"), "test('b', () => {});").unwrap();
    fs::write(
        pb.join("tests/b_other.test.ts"),
        "test('b_other', () => {});",
    )
    .unwrap();

    let bin_dir = tempdir().unwrap();
    let mock_bin = create_mock_provider(bin_dir.path());
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    let ts_provider = ScipTypescriptProvider::new();
    let fp = ts_provider.passive_fingerprint(repo, Some("1.0.0")).unwrap();

    // Package A has stale provider / edge (stale = 1)
    // Package B has fresh provider and fresh edge (stale = 0)
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
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/tests/b.test.ts', 'h3', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/src/b.ts', 'h4', 50, 100)",
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
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pb/tests/b.test.ts', 'file', 'packages/pb/tests/b.test.ts', 'pkg:npm:packages/pb')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pb/src/b.ts:fnB', 'symbol', 'packages/pb/src/b.ts', 'fnB', 'pkg:npm:packages/pb')",
                [],
            )
            .unwrap();

        // Fresh provider covering packages/pb
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at) VALUES ('scip-typescript', 'scip', '1.0.0', ?1, '0.1', '["typescript"]', '.', 'packages/pb', ?2, ?3, 'available', 'fresh', 1, 100, 100)"#,
                [&fp.executable_identity, &fp.config_fingerprint, &fp.digest],
            )
            .unwrap();

        // Stale edge in package A
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:stale_a', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', 'fp_a', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 1, 'scip-typescript')",
                [],
            )
            .unwrap();

        // Fresh edge in package B
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:fresh_b', 'file:packages/pb/tests/b.test.ts', 'sym:packages/pb/src/b.ts:fnB', 'references', 'scip_ts', ?1, 4, 'packages/pb/tests/b.test.ts', 'h3', 1, 1, 0, 'scip-typescript')",
                [&fp.digest],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify BOTH package A and package B
    fs::write(pa.join("src/a.ts"), "export function fnA() { return 2; }").unwrap();
    fs::write(pb.join("src/b.ts"), "export function fnB() { return 2; }").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // 1. Package A checks: a.test.ts retained as evidence AND other package A test selected via widening
    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("packages/pa/tests/a.test.ts"));
    assert!(a_test.is_some(), "a.test.ts must be selected");
    assert_eq!(a_test.unwrap().selection, SelectionReason::Evidence);

    let a_other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("packages/pa/tests/a_other.test.ts"));
    assert!(
        a_other_test.is_some(),
        "a_other.test.ts must be selected through widening of stale package A"
    );

    // 2. Package B checks: ONLY b.test.ts is selected precisely; b_other.test.ts MUST NOT be selected
    let b_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("packages/pb/tests/b.test.ts"));
    assert!(b_test.is_some(), "b.test.ts must be selected precisely");
    assert_eq!(b_test.unwrap().selection, SelectionReason::Evidence);
    assert_eq!(b_test.unwrap().strength, EvidenceStrength::Precise);

    let b_other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("packages/pb/tests/b_other.test.ts"));
    assert!(
        b_other_test.is_none(),
        "b_other.test.ts must NOT be selected because fresh package B is not widened"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}

#[test]
fn test_scoped_dynamic_config_in_package_a_does_not_widen_fresh_package_b() {
    let _lock = lock_env();
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pa = repo.join("packages/pa");
    let pb = repo.join("packages/pb");
    fs::create_dir_all(pa.join("src")).unwrap();
    fs::create_dir_all(pa.join("tests")).unwrap();
    fs::create_dir_all(pb.join("src")).unwrap();
    fs::create_dir_all(pb.join("tests")).unwrap();

    fs::write(
        pa.join("package.json"),
        r#"{ "name": "@my/pa", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pb.join("package.json"),
        r#"{ "name": "@my/pb", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    // Dynamic config in package A
    fs::write(
        pa.join("vitest.config.ts"),
        "export default defineConfig(() => ({ test: { include: process.env.X ? [] : [] } }));",
    )
    .unwrap();

    fs::write(pa.join("src/a.ts"), "export const a = 1;").unwrap();
    fs::write(pa.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pa.join("tests/a_other.test.ts"),
        "test('a_other', () => {});",
    )
    .unwrap();

    fs::write(pb.join("src/b.ts"), "export function fnB() { return 1; }").unwrap();
    fs::write(pb.join("tests/b.test.ts"), "test('b', () => {});").unwrap();
    fs::write(
        pb.join("tests/b_other.test.ts"),
        "test('b_other', () => {});",
    )
    .unwrap();

    let bin_dir = tempdir().unwrap();
    let mock_bin = create_mock_provider(bin_dir.path());
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    let ts_provider = ScipTypescriptProvider::new();
    let fp = ts_provider.passive_fingerprint(repo, Some("1.0.0")).unwrap();

    // Persist fresh provider for package B
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/tests/b.test.ts', 'h3', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pb/src/b.ts', 'h4', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pb/tests/b.test.ts', 'file', 'packages/pb/tests/b.test.ts', 'pkg:npm:packages/pb')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pb/src/b.ts:fnB', 'symbol', 'packages/pb/src/b.ts', 'fnB', 'pkg:npm:packages/pb')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0.0', ?1, '0.1', '["typescript"]', '.', 'packages/pb', ?2, ?3, 'available', 'fresh', 1, 100, 100)"#,
                [&fp.executable_identity, &fp.config_fingerprint, &fp.digest],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:fresh_b', 'file:packages/pb/tests/b.test.ts', 'sym:packages/pb/src/b.ts:fnB', 'references', 'scip_ts', ?1, 4, 'packages/pb/tests/b.test.ts', 'h3', 1, 1, 0, 'scip-typescript')",
                [&fp.digest],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify BOTH package A and package B
    fs::write(pa.join("src/a.ts"), "export const a = 2;").unwrap();
    fs::write(pb.join("src/b.ts"), "export function fnB() { return 2; }").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // 1. Package A must be widened due to dynamic config
    let a_other_test = plan.selected_checks.iter().find(|c| {
        c.check_id.contains("packages/pa/tests/a_other.test.ts")
            || c.check_id.contains("check:pkg:npm:packages/pa:test")
    });
    assert!(
        a_other_test.is_some(),
        "Package A must widen due to dynamic config"
    );

    // 2. Package B must NOT be widened by package A's dynamic config
    let b_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("packages/pb/tests/b.test.ts"));
    assert!(b_test.is_some(), "b.test.ts must be selected");
    assert_eq!(b_test.unwrap().selection, SelectionReason::Evidence);

    let b_other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("packages/pb/tests/b_other.test.ts"));
    assert!(
        b_other_test.is_none(),
        "Package B must NOT be widened because dynamic config in package A is scoped"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}
