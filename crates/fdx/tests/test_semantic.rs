//! Milestone 3 semantic provider failure boundaries and routing behavior.
//!
//! Fully offline: fake providers behind SCIP_TYPESCRIPT_BIN produce
//! deterministic SCIP fixtures copied to --output. No provider is ever
//! downloaded and no network is used.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use fdx::intelligence::semantic::ingest::{
    ingest_scip_index_with_faults, refresh_provider, refresh_provider_with_limits,
};
use fdx::intelligence::semantic::provider::{SemanticProvider, SemanticProviderError};
use fdx::intelligence::semantic::query::query_references;
use fdx::intelligence::semantic::router::IntelligenceIntent;
use fdx::intelligence::semantic::scip::decoder::decode_index;
use fdx::intelligence::semantic::scip::ts::ScipTypescriptProvider;
use fdx::intelligence::semantic::state;
use fdx::intelligence::semantic::LanguageId;
use fdx::protocol::EvidenceStrength;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/scip")
        .join(name)
}

/// Write a fake scip-typescript provider script: copies a fixture to the
/// --output argument; --version prints a version; modes fail/sleep/stderr_big
/// simulate provider failures.
fn write_provider(dir: &Path, fixture_name: &str, mode: &str) -> PathBuf {
    let bin = dir.join("scip-typescript");
    let fixture_abs = fixture(fixture_name);
    let mut script = String::new();
    script.push_str("#!/bin/bash\n");
    script.push_str("OUT=\"\"\n");
    script.push_str("PREV=\"\"\n");
    script.push_str("for a in \"$@\"; do\n");
    script.push_str("  if [ \"$PREV\" = \"--output\" ]; then OUT=\"$a\"; fi\n");
    script.push_str(
        "  if [ \"$a\" = \"--version\" ]; then echo \"scip-typescript 0.4.0\"; exit 0; fi\n",
    );
    script.push_str("  PREV=\"$a\"\n");
    script.push_str("done\n");
    script.push_str(&format!("MODE={}\n", mode));
    script.push_str("if [ \"$MODE\" = \"fail\" ]; then echo boom >&2; exit 7; fi\n");
    script.push_str("if [ \"$MODE\" = \"sleep\" ]; then sleep 30; exit 0; fi\n");
    script.push_str(
        "if [ \"$MODE\" = \"stderr_big\" ]; then head -c 100000 /dev/zero >&2; exit 0; fi\n",
    );
    script.push_str(&format!("cp \"{}\" \"$OUT\"\n", fixture_abs.display()));
    script.push_str("exit 0\n");
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
    std::fs::write(repo.join("src/b.ts"), "import { foo } from \"./a\";\n").unwrap();
    std::fs::write(repo.join("src/c.ts"), "let x = bar;\n").unwrap();
    std::fs::write(
        repo.join("tsconfig.json"),
        "{\"compilerOptions\":{\"strict\":true}}\n",
    )
    .unwrap();
}

fn seed_provider(
    mode: &str,
    fixture_name: &str,
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    std::sync::MutexGuard<'static, ()>,
) {
    let provider_dir = tempfile::tempdir().unwrap();
    let provider_bin = write_provider(provider_dir.path(), fixture_name, mode);
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let guard = ENV_LOCK.lock().unwrap();
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &provider_bin);
    (provider_dir, repo, guard)
}

fn open_db(repo: &Path) -> EvidenceDatabase {
    EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap()
}

fn node_count(db: &EvidenceDatabase, stable_id: &str) -> i64 {
    db.conn
        .query_row(
            "SELECT count(*) FROM nodes WHERE stable_id = ?1",
            [stable_id],
            |r| r.get(0),
        )
        .unwrap()
}

fn edge_count(db: &EvidenceDatabase) -> i64 {
    db.conn
        .query_row(
            "SELECT count(*) FROM edges WHERE provider = \"scip\"",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn provider_refresh_publishes_fresh_evidence_with_provenance() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    let report = refresh_provider(repo.path(), &provider, true).unwrap();
    assert!(report.documents >= 3);
    assert!(report.occurrences >= 5);
    assert!(report.nodes >= 3);
    let db = open_db(repo.path());
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.health, ProviderHealth::Available);
    assert_eq!(state.freshness, ProviderFreshness::Fresh);
    assert_eq!(state.semantic_generation, 1);
    assert!(!state.fingerprint.digest.is_empty());
    assert!(state.last_successful_run.is_some());
    assert!(edge_count(&db) >= 5);
    // Provenance: nodes carry provider + fingerprint; edges carry scip/Precise.
    let (n, e) = state::count_semantic_evidence(&db).unwrap();
    assert!(n >= 3);
    assert!(e >= 5);
    let _ = _pd;
}

#[test]
fn reference_query_uses_fresh_scip_with_precise_provenance() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let db = open_db(repo.path());
    // The fixture defines foo in src/a.ts; b.ts has a reference; c.ts imports.
    let result = query_references(
        repo.path(),
        Some(&db),
        LanguageId::TypeScript,
        "scip-typescript npm mypkg 1.0.0 src/a.ts/foo().",
        IntelligenceIntent::ReferenceComplete,
    )
    .unwrap();
    assert_eq!(result.provenance.strength, EvidenceStrength::Precise);
    assert!(!result.provenance.degraded);
    assert_eq!(
        result.completeness,
        fdx::intelligence::semantic::router::Completeness::CompleteWithinProviderScope,
    );
    assert!(!result.references.is_empty(), "expected references");
    let has_position = result.references.iter().any(|r| r.start_line > 0);
    assert!(has_position, "occurrence positions must be preserved");
    let _ = _pd;
}
#[test]
fn missing_provider_is_negative_evidence_never() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap(); // seed generation A
    let db = open_db(repo.path());
    let before_nodes = edge_count(&db);
    assert!(before_nodes > 0);

    // Now the provider disappears: remove the binary and refresh.
    let repo2 = repo.path().to_path_buf();
    drop(db);
    std::env::set_var("SCIP_TYPESCRIPT_BIN", "/nonexistent/scip-typescript");
    let err = refresh_provider(&repo2, &provider, true).unwrap_err();
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Provider(SemanticProviderError::Missing(
            _
        ))
    ));
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");

    // Old evidence intact, health=missing, freshness=absent.
    let db = open_db(&repo2);
    assert_eq!(
        edge_count(&db),
        before_nodes,
        "old evidence must be preserved"
    );
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.health, ProviderHealth::Missing);
    assert_eq!(state.freshness, ProviderFreshness::Absent);
    // Reference query falls back to structural, never claims completeness.
    let result = query_references(
        &repo2,
        Some(&db),
        LanguageId::TypeScript,
        "scip-typescript npm mypkg 1.0.0 src/a.ts/foo().",
        IntelligenceIntent::ReferenceComplete,
    )
    .unwrap();
    assert_eq!(
        result.completeness,
        fdx::intelligence::semantic::router::Completeness::Conservative,
    );
    let _ = _pd;
}

#[test]
fn provider_crash_preserves_old_evidence_and_keeps_fallback() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let db = open_db(repo.path());
    let before_edges = edge_count(&db);
    let before_generation = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap()
        .semantic_generation;
    drop(db);

    // Swap in a crashing provider.
    let crash_bin = write_provider(_pd.path(), "basic-ts.scip", "fail");
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &crash_bin);
    let err = refresh_provider(repo.path(), &provider, true).unwrap_err();
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Provider(SemanticProviderError::Failed(
            _
        ))
    ));

    let db = open_db(repo.path());
    assert_eq!(
        edge_count(&db),
        before_edges,
        "crash must not delete old evidence"
    );
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.health, ProviderHealth::Failed);
    assert_eq!(state.freshness, ProviderFreshness::Unknown);
    assert_eq!(
        state.semantic_generation, before_generation,
        "no new generation on failure"
    );
    let _ = _pd;
}

#[test]
fn provider_timeout_is_bounded_and_preserves_evidence() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let db = open_db(repo.path());
    let before_edges = edge_count(&db);
    drop(db);

    let slow_bin = write_provider(_pd.path(), "basic-ts.scip", "sleep");
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &slow_bin);
    let started = std::time::Instant::now();
    let err = refresh_provider_with_limits(
        repo.path(),
        &provider,
        true,
        Duration::from_millis(400),
        512 * 1024 * 1024,
        4 * 1024 * 1024,
    )
    .unwrap_err();
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "timeout must be bounded"
    );
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Provider(
            SemanticProviderError::TimedOut(_)
        )
    ));
    let db = open_db(repo.path());
    assert_eq!(edge_count(&db), before_edges);
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.health, ProviderHealth::TimedOut);
    let _ = _pd;
}
#[test]
fn provider_stderr_is_bounded() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let noisy_bin = write_provider(_pd.path(), "basic-ts.scip", "stderr_big");
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &noisy_bin);
    let err = refresh_provider_with_limits(
        repo.path(),
        &provider,
        true,
        Duration::from_secs(30),
        512 * 1024 * 1024,
        1024, // tiny stderr cap
    )
    .unwrap_err();
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Provider(
            SemanticProviderError::StderrTooLarge(_)
        )
    ));
    let _ = _pd;
}

#[test]
fn oversized_provider_output_fails_bounded() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let db = open_db(repo.path());
    let before_edges = edge_count(&db);
    drop(db);
    let re_run = write_provider(_pd.path(), "basic-ts.scip", "ok");
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &re_run);
    // Rerun with a tiny output cap: the fixture is way above it.
    let err = refresh_provider_with_limits(
        repo.path(),
        &provider,
        true,
        Duration::from_secs(30),
        64, // 64-byte output cap
        4 * 1024 * 1024,
    )
    .unwrap_err();
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Provider(
            SemanticProviderError::OutputTooLarge(_)
        )
    ));
    let db = open_db(repo.path());
    assert_eq!(
        edge_count(&db),
        before_edges,
        "oversized output must not publish"
    );
    let _ = _pd;
}

#[test]
fn malformed_scip_fails_closed_and_preserves_evidence() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let db = open_db(repo.path());
    let before_edges = edge_count(&db);
    drop(db);
    let re_run = write_provider(_pd.path(), "truncated-ts.scip", "ok");
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &re_run);
    let err = refresh_provider(repo.path(), &provider, true).unwrap_err();
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Scip(_)
    ));
    let db = open_db(repo.path());
    assert_eq!(
        edge_count(&db),
        before_edges,
        "malformed SCIP must not publish"
    );
    let _ = _pd;
}

#[test]
fn path_jail_rejects_escaping_document() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let jail_bin = write_provider(_pd.path(), "jail-escape.scip", "ok");
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &jail_bin);
    let err = refresh_provider(repo.path(), &provider, true).unwrap_err();
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::PathJail(_)
    ));
    let _ = _pd;
}
#[test]
fn atomic_refresh_old_generation_preserved_on_failure() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    let db = open_db(repo.path());
    let scope = provider.scope(repo.path());
    let fingerprint = provider.fingerprint(repo.path()).unwrap();
    let index_bytes = std::fs::read(fixture("basic-ts.scip")).unwrap();
    let index = decode_index(&index_bytes).unwrap();
    let result = fdx::intelligence::semantic::provider::SemanticIngestResult {
        output_path: fixture("basic-ts.scip"),
        output_digest: "a".to_string(),
        output_bytes: index_bytes.len() as u64,
        tool_name: Some("scip-typescript".to_string()),
        tool_version: Some("0.4.0".to_string()),
        provider_runtime_ms: 0,
    };
    let report_a = fdx::intelligence::semantic::ingest::ingest_scip_index(
        repo.path(),
        &provider,
        &scope,
        &fingerprint,
        &result,
        &index,
    )
    .unwrap();
    assert_eq!(report_a.generation, 1);
    let db = open_db(repo.path());
    let before_edges = edge_count(&db);
    let fp_after_a = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap()
        .fingerprint
        .digest;
    drop(db);
    // Generation B fails halfway through documents -> rollback.
    let err = ingest_scip_index_with_faults(
        repo.path(),
        &provider,
        &scope,
        &fingerprint,
        &result,
        &index,
        Some(1), // fail after the first document
        false,
    )
    .unwrap_err();
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Scip(_)
    ));
    let db = open_db(repo.path());
    assert_eq!(edge_count(&db), before_edges, "generation A fully intact");
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.semantic_generation, 1, "no generation B published");
    assert_eq!(
        state.fingerprint.digest, fp_after_a,
        "fingerprint still from A"
    );
    let _ = _pd;
}

#[test]
fn successful_refresh_replaces_old_generation() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    let db = open_db(repo.path());
    let scope = provider.scope(repo.path());
    let fingerprint = provider.fingerprint(repo.path()).unwrap();
    let index_bytes = std::fs::read(fixture("basic-ts.scip")).unwrap();
    let index = decode_index(&index_bytes).unwrap();
    let result = fdx::intelligence::semantic::provider::SemanticIngestResult {
        output_path: fixture("basic-ts.scip"),
        output_digest: "a".to_string(),
        output_bytes: index_bytes.len() as u64,
        tool_name: Some("scip-typescript".to_string()),
        tool_version: Some("0.4.0".to_string()),
        provider_runtime_ms: 0,
    };
    fdx::intelligence::semantic::ingest::ingest_scip_index(
        repo.path(),
        &provider,
        &scope,
        &fingerprint,
        &result,
        &index,
    )
    .unwrap();
    // Generation B: same index reingested (simulating provider refresh).
    let report_b = fdx::intelligence::semantic::ingest::ingest_scip_index(
        repo.path(),
        &provider,
        &scope,
        &fingerprint,
        &result,
        &index,
    )
    .unwrap();
    assert_eq!(report_b.generation, 2);
    let db = open_db(repo.path());
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.semantic_generation, 2);
    assert!(edge_count(&db) >= 5);
    let _ = _pd;
}
#[test]
fn scope_isolation_failure_in_one_provider_does_not_degrade_another() {
    // Seed a Rust provider (real rust-analyzer may be present; use SCIP_RUST_BIN
    // fake instead proves nothing about rust-analyzer availability).
    let rust_dir = tempfile::tempdir().unwrap();
    let rust_bin =
        write_provider_generic(rust_dir.path(), "scip-rust-shim", "basic-rust.scip", "ok");
    let repo = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(repo.path().join("src")).unwrap();
    std::fs::write(repo.path().join("src/lib.rs"), "pub fn area() {}\n").unwrap();
    std::fs::write(
        repo.path().join("Cargo.toml"),
        "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    let _guard = ENV_LOCK.lock().unwrap();
    std::env::set_var("SCIP_RUST_BIN", &rust_bin);
    let rust_provider = fdx::intelligence::semantic::scip::rust::ScipRustProvider::new();
    refresh_provider(repo.path(), &rust_provider, true).unwrap();
    std::env::remove_var("SCIP_RUST_BIN");
    drop(_guard);
    let db = open_db(repo.path());
    let rust_edges = edge_count(&db);
    assert!(rust_edges > 0);
    drop(db);
    // Now a FAILING typescript provider must not touch rust evidence.
    let ts_dir = tempfile::tempdir().unwrap();
    std::fs::write(repo.path().join("src/a.ts"), "const a = 1;\n").unwrap();
    let ts_bin = write_provider(ts_dir.path(), "basic-ts.scip", "fail");
    let _guard = ENV_LOCK.lock().unwrap();
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &ts_bin);
    let ts_provider = ScipTypescriptProvider::new();
    let err = refresh_provider(repo.path(), &ts_provider, true).unwrap_err();
    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
    drop(_guard);
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Provider(SemanticProviderError::Failed(
            _
        ))
    ));
    let db = open_db(repo.path());
    assert_eq!(
        edge_count(&db),
        rust_edges,
        "rust evidence untouched by TS failure"
    );
    let rust_state = state::load_provider_state(&db, "scip-rust")
        .unwrap()
        .unwrap();
    assert_eq!(
        rust_state.freshness,
        ProviderFreshness::Fresh,
        "rust scope stays fresh"
    );
    let _ = rust_dir;
    let _ = ts_dir;
}

fn write_provider_generic(dir: &Path, name: &str, fixture_name: &str, mode: &str) -> PathBuf {
    let bin = dir.join(name);
    let fixture_abs = fixture(fixture_name);
    let mut script = String::new();
    script.push_str("#!/bin/bash\n");
    script.push_str("OUT=\"\"\n");
    script.push_str("PREV=\"\"\n");
    script.push_str("for a in \"$@\"; do\n");
    script.push_str("  if [ \"$PREV\" = \"--output\" ]; then OUT=\"$a\"; fi\n");
    script.push_str("  if [ \"$a\" = \"--version\" ]; then echo \"0.1.0\"; exit 0; fi\n");
    script.push_str("  PREV=\"$a\"\n");
    script.push_str("done\n");
    script.push_str(&format!("MODE={}\n", mode));
    script.push_str("if [ \"$MODE\" = \"fail\" ]; then echo boom >&2; exit 7; fi\n");
    script.push_str(&format!("cp \"{}\" \"$OUT\"\n", fixture_abs.display()));
    script.push_str("exit 0\n");
    std::fs::write(&bin, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    bin
}
#[test]
fn config_invalidation_marks_provider_stale() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let db = open_db(repo.path());
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.freshness, ProviderFreshness::Fresh);
    drop(db);
    // Change the relevant config (tsconfig.json participates in the fingerprint).
    std::fs::write(
        repo.path().join("tsconfig.json"),
        "{\"compilerOptions\":{\"strict\":false,\"target\":\"esnext\"}}\n",
    )
    .unwrap();
    let db = open_db(repo.path());
    let changed = state::reconcile_provider_freshness(
        repo.path(),
        &fdx::intelligence::semantic::registry::ProviderRegistry::new(),
        &db,
    )
    .unwrap();
    assert!(
        changed >= 1,
        "config change must flip the provider to stale"
    );
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.freshness, ProviderFreshness::Stale);
    let _ = _pd;
}

#[test]
fn unrelated_config_does_not_invalidate_provider() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    // README.md is not a semantic resolution input for TS.
    std::fs::write(repo.path().join("README.md"), "totally unrelated\n").unwrap();
    let db = open_db(repo.path());
    let changed = state::reconcile_provider_freshness(
        repo.path(),
        &fdx::intelligence::semantic::registry::ProviderRegistry::new(),
        &db,
    )
    .unwrap();
    assert_eq!(
        changed, 0,
        "unrelated files must not invalidate semantic providers"
    );
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.freshness, ProviderFreshness::Fresh);
    let _ = _pd;
}

#[test]
fn file_change_marks_scoped_provider_stale() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let db = open_db(repo.path());
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(state.freshness, ProviderFreshness::Fresh);
    drop(db);
    // Change a source file: index refresh must mark the TS provider stale.
    std::fs::write(
        repo.path().join("src/a.ts"),
        "export function foo() { return 1; }\n",
    )
    .unwrap();
    fdx::intelligence::engine::run_incremental_index(repo.path(), true).unwrap();
    let db = open_db(repo.path());
    let state = state::load_provider_state(&db, "scip-typescript")
        .unwrap()
        .unwrap();
    assert_eq!(
        state.freshness,
        ProviderFreshness::Stale,
        "changed source => provider stale"
    );
    let _ = _pd;
}
#[test]
fn treesitter_fallback_provenance_is_structural() {
    let repo = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(repo.path().join("src")).unwrap();
    std::fs::write(
        repo.path().join("src/lib.rs"),
        "pub fn area(w: u32) -> u32 {\n    w\n}\nfn other() {\n    let a = area(2);\n}\n",
    )
    .unwrap();
    let result = query_references(
        repo.path(),
        None,
        LanguageId::Rust,
        "area",
        IntelligenceIntent::ReferenceComplete,
    )
    .unwrap();
    assert_eq!(result.provenance.strength, EvidenceStrength::Structural);
    assert!(result.provenance.degraded);
    assert_eq!(result.provenance.provider, None);
    assert_ne!(
        result.completeness,
        fdx::intelligence::semantic::router::Completeness::CompleteWithinProviderScope,
    );
    assert!(
        !result.references.is_empty(),
        "definition/reference must be found"
    );
}
#[test]
fn cheap_localize_query_never_touches_scip() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let db = open_db(repo.path());
    let result = query_references(
        repo.path(),
        Some(&db),
        LanguageId::TypeScript,
        "foo",
        IntelligenceIntent::Localize,
    )
    .unwrap();
    assert_ne!(result.provenance.strength, EvidenceStrength::Precise);
    assert!(result.provenance.degraded);
    let result2 = query_references(
        repo.path(),
        Some(&db),
        LanguageId::TypeScript,
        "foo",
        IntelligenceIntent::Context,
    )
    .unwrap();
    assert_ne!(result2.provenance.strength, EvidenceStrength::Precise);
    let _ = _pd;
}
#[test]
fn unsupported_language_never_claims_semantic_completeness() {
    let repo = tempfile::tempdir().unwrap();
    std::fs::write(repo.path().join("main.py"), "def f():\n    pass\n").unwrap();
    let provider = ScipTypescriptProvider::new();
    let err = refresh_provider(repo.path(), &provider, true).unwrap_err();
    assert!(matches!(
        err,
        fdx::intelligence::semantic::ingest::IngestError::Provider(
            SemanticProviderError::UnsupportedLanguage(_)
        )
    ));
}
#[test]
fn symbol_identity_is_stable_and_package_qualified() {
    let (_pd, repo, _g) = seed_provider("ok", "basic-ts.scip");
    let provider = ScipTypescriptProvider::new();
    refresh_provider(repo.path(), &provider, true).unwrap();
    let db = open_db(repo.path());
    let id_foo: String = db
        .conn
        .query_row(
            "SELECT stable_id FROM nodes WHERE symbol_identity = ?1",
            ["scip-typescript npm mypkg 1.0.0 src/a.ts/foo()."],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        id_foo, "sem:scip-typescript npm mypkg 1.0.0 src/a.ts/foo().",
        "stable id must use the SCIP canonical symbol identity",
    );
    let id_ext: String = db
        .conn
        .query_row(
            "SELECT stable_id FROM nodes WHERE symbol_identity = ?1",
            ["scip-typescript npm otherpkg 1.0.0 src/other/foo()."],
            |r| r.get(0),
        )
        .unwrap();
    assert_ne!(
        id_foo, id_ext,
        "different package, same name => different id"
    );
    let _ = _pd;
}
