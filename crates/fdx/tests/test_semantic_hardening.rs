//! Milestone 3 hardening tests: effective freshness, source-aware invalidation,
//! real derivation provenance, attempt diagnostics preservation, cache cleanup,
//! and Windows PATHEXT executable resolution.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use fdx::intelligence::semantic::ingest::refresh_provider;
use fdx::intelligence::semantic::provider::{find_executable, SemanticProviderError};
use fdx::intelligence::semantic::query::query_references;
use fdx::intelligence::semantic::router::{Completeness, EvidenceSource, IntelligenceIntent};
use fdx::intelligence::semantic::scip::rust::ScipRustProvider;
use fdx::intelligence::semantic::scip::ts::ScipTypescriptProvider;
use fdx::intelligence::semantic::state;
use fdx::intelligence::semantic::LanguageId;
use fdx::protocol::EvidenceStrength;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/scip")
        .join(name)
}

fn write_provider(dir: &Path, fixture_name: &str, mode: &str) -> PathBuf {
    let bin = dir.join("scip-typescript");
    let fixture_abs = fixture(fixture_name);
    let script = format!(
        "#!/bin/bash\n        OUT=\"\"\n        PREV=\"\"\n        for a in \"$@\"; do\n          if [ \"$PREV\" = \"--output\" ]; then OUT=\"$a\"; fi\n          if [ \"$a\" = \"--version\" ]; then echo \"scip-typescript 0.4.0\"; exit 0; fi\n          PREV=\"$a\"\n        done\n        MODE={}\n        if [ \"$MODE\" = \"fail\" ]; then echo boom >&2; exit 7; fi\n        if [ \"$MODE\" = \"sleep\" ]; then sleep 30; exit 0; fi\n        if [ \"$MODE\" = \"stderr_big\" ]; then head -c 100000 /dev/zero >&2; exit 0; fi\n        cp \"{}\" \"$OUT\"\n        exit 0\n",
        mode,
        fixture_abs.display()
    );
    std::fs::write(&bin, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    bin
}

fn write_rust_provider(dir: &Path, fixture_name: &str) -> PathBuf {
    let bin = dir.join("scip-rust-shim");
    let fixture_abs = fixture(fixture_name);
    let script = format!(
        "#!/bin/bash\n        OUT=\"\"\n        PREV=\"\"\n        for a in \"$@\"; do\n          if [ \"$PREV\" = \"--output\" ]; then OUT=\"$a\"; fi\n          if [ \"$a\" = \"--version\" ]; then echo \"0.1.0\"; exit 0; fi\n          PREV=\"$a\"\n        done\n        cp \"{}\" \"$OUT\"\n        exit 0\n",
        fixture_abs.display()
    );
    std::fs::write(&bin, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    bin
}

fn ts_repo(repo: &Path) {
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(
        repo.join("src/a.ts"),
        "export function foo() {}\nexport function bar() {}\n",
    )
    .unwrap();
    std::fs::write(repo.join("src/b.ts"), r#"import { foo } from "./a";"#).unwrap();
    std::fs::write(repo.join("src/c.ts"), "let x = bar;\n").unwrap();
    std::fs::write(
        repo.join("tsconfig.json"),
        r#"{"compilerOptions":{"strict":true}}"#,
    )
    .unwrap();
}

fn dual_repo(repo: &Path) {
    ts_repo(repo);
    std::fs::write(repo.join("src/lib.rs"), "pub fn area() {}\n").unwrap();
    let _ = std::fs::write(
        repo.join("Cargo.toml"),
        r#"[package]
name = "demo"
version = "0.1.0"
"#,
    );
    std::fs::write(repo.join("README.md"), "# Demo Project\n").unwrap();
}

fn seed_ts(repo: &Path) -> (tempfile::TempDir, std::sync::MutexGuard<'static, ()>) {
    let dir = tempfile::tempdir().unwrap();
    let bin = write_provider(dir.path(), "basic-ts.scip", "ok");
    let guard = lock_env();
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &bin);
    let _ = fdx::intelligence::engine::run_incremental_index(repo, false);
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo, &provider, true).unwrap();
    (dir, guard)
}

fn seed_rust(repo: &Path) -> (tempfile::TempDir, std::sync::MutexGuard<'static, ()>) {
    let dir = tempfile::tempdir().unwrap();
    let bin = write_rust_provider(dir.path(), "basic-rust.scip");
    let guard = lock_env();
    std::env::set_var("SCIP_RUST_BIN", &bin);
    let _ = fdx::intelligence::engine::run_incremental_index(repo, false);
    let provider = ScipRustProvider::new();
    refresh_provider(repo, &provider, true).unwrap();
    (dir, guard)
}

#[test]
fn test_effective_freshness_reacts_to_tsconfig_change_at_read_time() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let (_dir, guard) = seed_ts(repo.path());

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let query1 = query_references(
        repo.path(),
        Some(&db),
        LanguageId::TypeScript,
        "scip-typescript npm mypkg 1.0.0 src/a.ts/foo().",
        IntelligenceIntent::ReferenceComplete,
    )
    .unwrap();
    assert_eq!(query1.source, EvidenceSource::Scip);
    assert_eq!(query1.provenance.strength, EvidenceStrength::Precise);
    assert_eq!(
        query1.completeness,
        Completeness::CompleteWithinProviderScope
    );

    // Mutate tsconfig on disk WITHOUT running refresh.
    std::fs::write(
        repo.path().join("tsconfig.json"),
        r#"{"compilerOptions":{"strict":false}}"#,
    )
    .unwrap();

    // Query directly: non-mutating read must detect effective staleness.
    let query2 = query_references(
        repo.path(),
        Some(&db),
        LanguageId::TypeScript,
        "scip-typescript npm mypkg 1.0.0 src/a.ts/foo().",
        IntelligenceIntent::ReferenceComplete,
    )
    .unwrap();
    assert_eq!(
        query2.source,
        EvidenceSource::TreeSitter,
        "stale provider must degrade to TreeSitter fallback"
    );
    assert_eq!(query2.provenance.strength, EvidenceStrength::Structural);
    assert_eq!(query2.completeness, Completeness::Conservative);
    assert!(query2.provenance.degraded);

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard);
}

#[test]
fn test_effective_freshness_reacts_to_missing_executable_at_read_time() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let (dir, guard) = seed_ts(repo.path());

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();

    // Executable is removed / missing on disk
    let _ = std::fs::remove_file(dir.path().join("scip-typescript"));

    let query = query_references(
        repo.path(),
        Some(&db),
        LanguageId::TypeScript,
        "scip-typescript npm mypkg 1.0.0 src/a.ts/foo().",
        IntelligenceIntent::ReferenceComplete,
    )
    .unwrap();
    assert_ne!(
        query.source,
        EvidenceSource::Scip,
        "missing executable must not be used as fresh SCIP"
    );
    assert_eq!(query.provenance.strength, EvidenceStrength::Structural);
    assert!(query.provenance.degraded);

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard);
}

#[test]
fn test_source_deletion_stales_provider_on_index() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let (_dir, guard) = seed_ts(repo.path());

    // Baseline file index is fresh
    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let state_before = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state_before.freshness, ProviderFreshness::Fresh);
    drop(db);

    // Delete a source file
    std::fs::remove_file(repo.path().join("src/b.ts")).unwrap();

    // Run incremental index
    fdx::intelligence::engine::run_incremental_index(repo.path(), false).unwrap();

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let state_after = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(
        state_after.freshness,
        ProviderFreshness::Stale,
        "deleted source file must stale provider on index"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard);
}

#[test]
fn test_source_rename_stales_provider_on_index() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let (_dir, guard) = seed_ts(repo.path());

    // Rename src/a.ts -> src/a_renamed.ts
    std::fs::rename(
        repo.path().join("src/a.ts"),
        repo.path().join("src/a_renamed.ts"),
    )
    .unwrap();

    fdx::intelligence::engine::run_incremental_index(repo.path(), false).unwrap();

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let state_after = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(
        state_after.freshness,
        ProviderFreshness::Stale,
        "renamed source file must stale provider on index"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard);
}

#[test]
fn test_unrelated_readme_change_does_not_stale_providers() {
    let repo = tempfile::tempdir().unwrap();
    dual_repo(repo.path());
    let (_dir_ts, guard_ts) = seed_ts(repo.path());
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard_ts);

    let (_dir_rust, guard_rust) = seed_rust(repo.path());
    std::env::remove_var("SCIP_RUST_BIN");
    drop(guard_rust);

    // Mutate unrelated README.md
    std::fs::write(repo.path().join("README.md"), "# Updated Demo\nNew text.\n").unwrap();

    fdx::intelligence::engine::run_incremental_index(repo.path(), false).unwrap();

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let ts_state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    let rust_state = state::load_provider_state(&db, "scip-rust")
        .unwrap()
        .unwrap();

    assert_eq!(
        ts_state.freshness,
        ProviderFreshness::Fresh,
        "TS provider must stay fresh after README change"
    );
    assert_eq!(
        rust_state.freshness,
        ProviderFreshness::Fresh,
        "Rust provider must stay fresh after README change"
    );
}

#[test]
fn test_ts_change_does_not_stale_rust_provider() {
    let repo = tempfile::tempdir().unwrap();
    dual_repo(repo.path());
    let (_dir_ts, guard_ts) = seed_ts(repo.path());
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard_ts);

    let (_dir_rust, guard_rust) = seed_rust(repo.path());
    std::env::remove_var("SCIP_RUST_BIN");
    drop(guard_rust);

    // Modify a TS file only
    std::fs::write(
        repo.path().join("src/a.ts"),
        "export function foo() { return 42; }\n",
    )
    .unwrap();

    fdx::intelligence::engine::run_incremental_index(repo.path(), false).unwrap();

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let ts_state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    let rust_state = state::load_provider_state(&db, "scip-rust")
        .unwrap()
        .unwrap();

    assert_eq!(
        ts_state.freshness,
        ProviderFreshness::Stale,
        "TS provider must become stale"
    );
    assert_eq!(
        rust_state.freshness,
        ProviderFreshness::Fresh,
        "Rust provider must stay fresh"
    );
}

#[test]
fn test_rust_change_does_not_stale_ts_provider() {
    let repo = tempfile::tempdir().unwrap();
    dual_repo(repo.path());
    let (_dir_ts, guard_ts) = seed_ts(repo.path());
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard_ts);

    let (_dir_rust, guard_rust) = seed_rust(repo.path());
    std::env::remove_var("SCIP_RUST_BIN");
    drop(guard_rust);

    // Modify a Rust file only
    std::fs::write(
        repo.path().join("src/lib.rs"),
        "pub fn area() -> u32 { 10 }\n",
    )
    .unwrap();

    fdx::intelligence::engine::run_incremental_index(repo.path(), false).unwrap();

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let ts_state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    let rust_state = state::load_provider_state(&db, "scip-rust")
        .unwrap()
        .unwrap();

    assert_eq!(
        rust_state.freshness,
        ProviderFreshness::Stale,
        "Rust provider must become stale"
    );
    assert_eq!(
        ts_state.freshness,
        ProviderFreshness::Fresh,
        "TS provider must stay fresh"
    );
}

#[test]
fn test_provenance_populated_on_all_nodes_and_edges() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let (_dir, guard) = seed_ts(repo.path());

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();

    // Check all provider-owned symbol nodes have non-None source_identity and source_hash
    let mut stmt = db
        .conn
        .prepare(
            "SELECT stable_id, canonical_path, source_hash FROM nodes WHERE provider IS NOT NULL AND kind = 'symbol'",
        )
        .unwrap();
    let rows: Vec<(String, Option<String>, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .flatten()
        .collect();

    assert!(!rows.is_empty(), "expected semantic symbol nodes");
    for (id, path, hash) in &rows {
        assert!(
            path.is_some(),
            "symbol node {} must have canonical_path",
            id
        );
        assert!(hash.is_some(), "symbol node {} must have source_hash", id);
        assert!(!hash.as_ref().unwrap().is_empty());
    }

    // Check all edges have source_identity and source_hash
    let mut edge_stmt = db
        .conn
        .prepare(
            "SELECT stable_id, source_identity, source_hash FROM edges WHERE provider = 'scip'",
        )
        .unwrap();
    let edge_rows: Vec<(String, Option<String>, Option<String>)> = edge_stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .flatten()
        .collect();

    assert!(!edge_rows.is_empty(), "expected semantic edges");
    for (id, src_id, src_hash) in &edge_rows {
        assert!(src_id.is_some(), "edge {} must have source_identity", id);
        assert!(src_hash.is_some(), "edge {} must have source_hash", id);
        assert!(!src_id.as_ref().unwrap().is_empty());
        assert!(!src_hash.as_ref().unwrap().is_empty());
    }

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard);
}

#[test]
fn test_failed_refresh_preserves_active_fingerprint_and_records_attempt() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let (_dir, guard) = seed_ts(repo.path());

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let state_a = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    let active_fp_a = state_a.fingerprint.digest.clone();
    assert_eq!(state_a.semantic_generation, 1);
    drop(db);

    // Swap to failing provider
    let fail_dir = tempfile::tempdir().unwrap();
    let fail_bin = write_provider(fail_dir.path(), "basic-ts.scip", "fail");
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &fail_bin);

    let provider = ScipTypescriptProvider::new();
    let err = refresh_provider(repo.path(), &provider, true).unwrap_err();
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Provider(SemanticProviderError::Failed(
            _
        ))
    ));

    let db = EvidenceDatabase::open(repo.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let state_after_fail = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();

    // Active fingerprint and generation must remain A
    assert_eq!(
        state_after_fail.fingerprint.digest, active_fp_a,
        "active fingerprint must stay A"
    );
    assert_eq!(
        state_after_fail.semantic_generation, 1,
        "active generation must stay 1"
    );
    assert!(state_after_fail.last_successful_run.is_some());

    // Attempt diagnostics must reflect failure
    assert!(
        state_after_fail.last_attempt_fingerprint.is_some(),
        "attempt fingerprint must be recorded"
    );
    assert_eq!(
        state_after_fail.last_attempt_health,
        Some(ProviderHealth::Failed)
    );
    assert!(state_after_fail.last_attempt_failure_reason.is_some());

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard);
}

#[test]
fn test_temp_scip_cleaned_up_on_success_and_failure() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());

    let cache_dir = repo.path().join(".fdx").join("cache");

    // Success case
    let (_dir, guard) = seed_ts(repo.path());
    let scip_files = count_scip_files(&cache_dir);
    assert_eq!(
        scip_files, 0,
        "cache must not contain orphan .scip files after success"
    );
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard);

    // Fail case
    let fail_dir = tempfile::tempdir().unwrap();
    let fail_bin = write_provider(fail_dir.path(), "basic-ts.scip", "fail");
    let guard = lock_env();
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &fail_bin);
    let provider = ScipTypescriptProvider::new();
    let _ = refresh_provider(repo.path(), &provider, true);
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(guard);

    let scip_files_after_fail = count_scip_files(&cache_dir);
    assert_eq!(
        scip_files_after_fail, 0,
        "cache must not contain orphan .scip files after failure"
    );
}

fn count_scip_files(dir: &Path) -> usize {
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().map(|x| x == "scip").unwrap_or(false))
        .count()
}

#[test]
fn test_windows_executable_discovery_pathext() {
    let dir = tempfile::tempdir().unwrap();
    let exe_name = "test-custom-indexer";

    // Create test-custom-indexer.cmd
    let cmd_file = dir.path().join(format!("{}.cmd", exe_name));
    std::fs::write(&cmd_file, "@echo off\necho 1.0.0\n").unwrap();

    let guard = lock_env();
    let orig_path = std::env::var_os("PATH").unwrap_or_default();
    let mut new_path = dir.path().to_path_buf().into_os_string();
    new_path.push(if cfg!(windows) { ";" } else { ":" });
    new_path.push(&orig_path);

    std::env::set_var("PATH", &new_path);
    #[cfg(windows)]
    std::env::set_var("PATHEXT", ".COM;.EXE;.BAT;.CMD");

    let found = find_executable(exe_name);
    std::env::set_var("PATH", &orig_path);
    drop(guard);

    #[cfg(windows)]
    {
        assert!(found.is_some(), "should find .cmd on Windows");
        assert_eq!(found.unwrap(), cmd_file);
    }
    #[cfg(not(windows))]
    {
        // On Unix, looking up test-custom-indexer when only test-custom-indexer.cmd exists returns None
        assert!(found.is_none());
    }
}
