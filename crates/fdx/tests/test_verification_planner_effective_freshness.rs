//! Milestone 6 / M3 Effective Provider Freshness Integration Tests.
//!
//! Asserts that M6 verification planner uses passive effective provider freshness
//! (recomputing executable + config hashes on the fly) rather than directly trusting
//! persisted SQLite provider rows.

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

fn create_mock_provider(dir: &Path, witness_path: Option<&Path>) -> PathBuf {
    let bin = dir.join("mock-scip-ts");
    let mut script = String::from("#!/bin/sh\n");
    if let Some(w) = witness_path {
        script.push_str(&format!("touch \"{}\"\n", w.display()));
    }
    script.push_str(
        "if [ \"$1\" = \"--version\" ]; then echo \"scip-typescript 1.0.0\"; exit 0; fi\n",
    );
    script.push_str("exit 0\n");
    fs::write(&bin, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    }
    bin
}

#[test]
fn test_persisted_fresh_and_unchanged_passive_fingerprint_narrows_control() {
    let _lock = lock_env();
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/api");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/api", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("tsconfig.json"),
        r#"{ "compilerOptions": { "strict": true } }"#,
    )
    .unwrap();
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }\nexport function fnOther() { return 2; }\n",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    let bin_dir = tempdir().unwrap();
    let mock_bin = create_mock_provider(bin_dir.path(), None);
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    // Compute passive fingerprint against current repo and mock binary
    let ts_provider = ScipTypescriptProvider::new();
    let fp = ts_provider
        .passive_fingerprint(repo, Some("1.0.0"))
        .unwrap();

    // Persist provider state with matching fingerprint in SQLite DB
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/api/tests/a.test.ts', 'file', 'packages/api/tests/a.test.ts', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/api/src/a.ts:fnA', 'symbol', 'packages/api/src/a.ts', 'fnA', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0.0', ?1, '0.1', '["typescript"]', '.', 'packages/api', ?2, ?3, 'available', 'fresh', 1, 100, 100)"#,
                [&fp.executable_identity, &fp.config_fingerprint, &fp.digest],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/api/tests/a.test.ts', 'sym:packages/api/src/a.ts:fnA', 'references', 'scip_ts', ?1, 4, 'packages/api/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-typescript')",
                [&fp.digest],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify a.ts
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }\nexport function fnOther() { return 2; }\n",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "a.test.ts must be selected");
    assert_eq!(a_test.unwrap().selection, SelectionReason::Evidence);

    let has_other = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("other.test.ts"));
    assert!(
        !has_other,
        "When effective provider is fresh and unchanged, unrelated other.test.ts must NOT be selected"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}

#[test]
fn test_persisted_fresh_and_changed_config_fingerprint_widens_conservatively() {
    let _lock = lock_env();
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/api");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/api", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("tsconfig.json"),
        r#"{ "compilerOptions": { "strict": true } }"#,
    )
    .unwrap();
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }\nexport function fnOther() { return 2; }\n",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    let bin_dir = tempdir().unwrap();
    let mock_bin = create_mock_provider(bin_dir.path(), None);
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    // Compute passive fingerprint against original state
    let ts_provider = ScipTypescriptProvider::new();
    let fp = ts_provider
        .passive_fingerprint(repo, Some("1.0.0"))
        .unwrap();

    // Persist provider state as Fresh with original fingerprint
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/api/tests/a.test.ts', 'file', 'packages/api/tests/a.test.ts', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/api/src/a.ts:fnA', 'symbol', 'packages/api/src/a.ts', 'fnA', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0.0', ?1, '0.1', '["typescript"]', '.', 'packages/api', ?2, ?3, 'available', 'fresh', 1, 100, 100)"#,
                [&fp.executable_identity, &fp.config_fingerprint, &fp.digest],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/api/tests/a.test.ts', 'sym:packages/api/src/a.ts:fnA', 'references', 'scip_ts', ?1, 4, 'packages/api/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-typescript')",
                [&fp.digest],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify a.ts AND mutate tsconfig.json (config mutation without semantic refresh)
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }\nexport function fnOther() { return 2; }\n",
    )
    .unwrap();
    fs::write(
        repo.join("tsconfig.json"),
        r#"{ "compilerOptions": { "strict": false, "target": "ES2022" } }"#,
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Milestone 6 Invariant: historical mapped test is retained for positive safety
    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "Mapped a.test.ts must be retained");

    // Package MUST widen due to effective provider staleness
    let has_widened_check = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("other.test.ts") || c.check_id.contains("packages/api:test"));
    assert!(
        has_widened_check,
        "Package must widen when passive config fingerprint changed"
    );

    // Assurance must not be Exact
    assert_ne!(
        plan.assurance,
        AssuranceLevel::Exact,
        "Assurance must degrade on effective provider staleness"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}

#[test]
fn test_persisted_fresh_and_changed_executable_fingerprint_widens() {
    let _lock = lock_env();
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/api");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/api", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }\nexport function fnOther() { return 2; }\n",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    let bin_dir = tempdir().unwrap();
    let mock_bin = create_mock_provider(bin_dir.path(), None);
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    // Compute passive fingerprint against initial executable
    let ts_provider = ScipTypescriptProvider::new();
    let fp = ts_provider
        .passive_fingerprint(repo, Some("1.0.0"))
        .unwrap();

    // Persist provider state as Fresh with original fingerprint
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/api/tests/a.test.ts', 'file', 'packages/api/tests/a.test.ts', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/api/src/a.ts:fnA', 'symbol', 'packages/api/src/a.ts', 'fnA', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0.0', ?1, '0.1', '["typescript"]', '.', 'packages/api', ?2, ?3, 'available', 'fresh', 1, 100, 100)"#,
                [&fp.executable_identity, &fp.config_fingerprint, &fp.digest],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/api/tests/a.test.ts', 'sym:packages/api/src/a.ts:fnA', 'references', 'scip_ts', ?1, 4, 'packages/api/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-typescript')",
                [&fp.digest],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify a.ts AND modify provider executable bytes
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }\nexport function fnOther() { return 2; }\n",
    )
    .unwrap();
    fs::write(&mock_bin, "#!/bin/sh\necho changed\nexit 0\n").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "Mapped a.test.ts must be retained");

    let has_widened = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("other.test.ts") || c.check_id.contains("packages/api:test"));
    assert!(
        has_widened,
        "Package must widen when provider binary hash changed"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}

#[test]
fn test_persisted_fresh_and_provider_disappears_widens() {
    let _lock = lock_env();
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/api");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/api", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }\nexport function fnOther() { return 2; }\n",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    let bin_dir = tempdir().unwrap();
    let mock_bin = create_mock_provider(bin_dir.path(), None);
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    let ts_provider = ScipTypescriptProvider::new();
    let fp = ts_provider
        .passive_fingerprint(repo, Some("1.0.0"))
        .unwrap();

    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/api/tests/a.test.ts', 'file', 'packages/api/tests/a.test.ts', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/api/src/a.ts:fnA', 'symbol', 'packages/api/src/a.ts', 'fnA', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0.0', ?1, '0.1', '["typescript"]', '.', 'packages/api', ?2, ?3, 'available', 'fresh', 1, 100, 100)"#,
                [&fp.executable_identity, &fp.config_fingerprint, &fp.digest],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/api/tests/a.test.ts', 'sym:packages/api/src/a.ts:fnA', 'references', 'scip_ts', ?1, 4, 'packages/api/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-typescript')",
                [&fp.digest],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Modify a.ts AND remove provider executable completely
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }\nexport function fnOther() { return 2; }\n",
    )
    .unwrap();
    let _ = fs::remove_file(&mock_bin);

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"));
    assert!(a_test.is_some(), "Mapped a.test.ts must be retained");

    let has_widened = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("other.test.ts") || c.check_id.contains("packages/api:test"));
    assert!(
        has_widened,
        "Package must widen when provider executable disappears"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}

#[test]
fn test_plan_is_strictly_read_only_and_does_not_execute_providers() {
    let _lock = lock_env();
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/api");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/api", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }\n",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();

    let witness = repo.join("witness_execution.txt");
    let bin_dir = tempdir().unwrap();
    let mock_bin = create_mock_provider(bin_dir.path(), Some(&witness));
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    let ts_provider = ScipTypescriptProvider::new();
    let fp = ts_provider
        .passive_fingerprint(repo, Some("1.0.0"))
        .unwrap();

    let db_path = repo.join(".fdx/index.sqlite");
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/api/tests/a.test.ts', 'file', 'packages/api/tests/a.test.ts', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/api/src/a.ts:fnA', 'symbol', 'packages/api/src/a.ts', 'fnA', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0.0', ?1, '0.1', '["typescript"]', '.', 'packages/api', ?2, ?3, 'available', 'fresh', 1, 100, 100)"#,
                [&fp.executable_identity, &fp.config_fingerprint, &fp.digest],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:a_test', 'file:packages/api/tests/a.test.ts', 'sym:packages/api/src/a.ts:fnA', 'references', 'scip_ts', ?1, 4, 'packages/api/tests/a.test.ts', 'h1', 1, 1, 0, 'scip-typescript')",
                [&fp.digest],
            )
            .unwrap();
    }

    let db_bytes_before = fs::read(&db_path).unwrap();

    git_commit_all(repo, "initial");

    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }\n",
    )
    .unwrap();

    let _plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    assert!(
        !witness.exists(),
        "Provider binary must NEVER be executed during plan_verification"
    );

    let db_bytes_after = fs::read(&db_path).unwrap();
    assert_eq!(
        db_bytes_before, db_bytes_after,
        "Database bytes must be unchanged during plan_verification"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}
