//! Tests for evidence provenance retention (provider_id, fingerprint, evidence_id, source_identity, strength, stale).

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
fn test_persisted_scip_edge_provenance_preserved_in_planned_check() {
    let _lock = lock_env();
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/prov");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/prov", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(
        pkg_dir.join("src/calc.ts"),
        "export function add(a: number, b: number) { return a + b; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/calc.test.ts"), "test('add', () => {});").unwrap();

    let bin_dir = tempdir().unwrap();
    let mock_bin = create_mock_provider(bin_dir.path());
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    let ts_provider = ScipTypescriptProvider::new();
    let fp = ts_provider.passive_fingerprint(repo, Some("1.0.0")).unwrap();

    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/prov/tests/calc.test.ts', 'hash_test', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/prov/src/calc.ts', 'hash_src', 50, 100)",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/prov/tests/calc.test.ts', 'file', 'packages/prov/tests/calc.test.ts', 'pkg:npm:packages/prov')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/prov/src/calc.ts:add', 'symbol', 'packages/prov/src/calc.ts', 'add', 'pkg:npm:packages/prov')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0.0', ?1, '0.1', '["typescript"]', '.', 'packages/prov', ?2, ?3, 'available', 'fresh', 1, 100, 100)"#,
                [&fp.executable_identity, &fp.config_fingerprint, &fp.digest],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:calc_test_to_add', 'file:packages/prov/tests/calc.test.ts', 'sym:packages/prov/src/calc.ts:add', 'references', 'scip_ts', ?1, 4, 'packages/prov/tests/calc.test.ts', 'hash_test', 1, 1, 0, 'scip-typescript')",
                [&fp.digest],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");
    fs::write(
        pkg_dir.join("src/calc.ts"),
        "export function add(a: number, b: number) { return a + b + 1; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let test_check = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("calc.test.ts"))
        .expect("calc.test.ts selected");

    assert_eq!(test_check.selection, SelectionReason::Evidence);
    assert_eq!(test_check.strength, EvidenceStrength::Precise);
    assert!(!test_check.evidence_refs.is_empty());

    let ref_item = &test_check.evidence_refs[0];
    assert_eq!(
        ref_item.evidence_id.as_deref(),
        Some("edge:calc_test_to_add")
    );
    assert_eq!(ref_item.provider_id, "scip-typescript");
    assert_eq!(ref_item.provider_fingerprint.as_deref(), Some(fp.digest.as_str()));
    assert_eq!(ref_item.strength, EvidenceStrength::Precise);
    assert!(!ref_item.stale);

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}
