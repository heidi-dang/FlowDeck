//! Milestone 4 integration with M3 canonical SCIP symbols and effective freshness.

use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use fdx::intelligence::semantic::provider::{
    now_ms, ProviderFingerprint, ProviderIdentity, ProviderScope, ProviderState, ProviderType,
};
use fdx::intelligence::semantic::state::upsert_provider_state;
use fdx::intelligence::semantic::LanguageId;
use fdx::protocol::{AssuranceLevel, EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
use std::fs;
use std::path::Path;
use std::process::Command;

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
fn test_m3_canonical_scip_symbol_resolves_to_m4_seed() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("src/a.ts");
    let file_b = repo.join("src/b.ts");
    let tsconfig = repo.join("tsconfig.json");

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        &file_a,
        "export function computeTotal(): number { return 42; }
",
    )
    .unwrap();
    fs::write(
        &file_b,
        "import { computeTotal } from './a';
export const total = computeTotal();
",
    )
    .unwrap();
    fs::write(&tsconfig, r#"{"compilerOptions":{"strict":true}}"#).unwrap();
    git_commit_all(repo, "initial");

    // Real M3 SCIP ingestion schema format:
    // stable_id = sem:scip-typescript npm @demo/pkg 1.0.0 src/a.ts/computeTotal().
    // symbol_identity = scip-typescript npm @demo/pkg 1.0.0 src/a.ts/computeTotal().
    // metadata = {"display_name":"computeTotal","scip_kind":17}
    let canonical_scip_id = "sem:scip-typescript npm @demo/pkg 1.0.0 src/a.ts/computeTotal().";
    let canonical_symbol_identity = "scip-typescript npm @demo/pkg 1.0.0 src/a.ts/computeTotal().";

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/a.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 100,
        content_hash: "h1".to_string(),
        mtime_ms: None,
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/b.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 100,
        content_hash: "h2".to_string(),
        mtime_ms: None,
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: canonical_scip_id.to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/a.ts".to_string()),
        symbol_identity: Some(canonical_symbol_identity.to_string()),
        package_identity: Some("pkg:npm/@demo/pkg@1.0.0".to_string()),
        metadata: Some(r#"{"display_name":"computeTotal","scip_kind":17}"#.to_string()),
        source_identity: None,
    })
    .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: "file:src/b.ts".to_string(),
        kind: NodeKind::File,
        canonical_path: Some("src/b.ts".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
        source_identity: None,
    })
    .unwrap();
    tx.insert_edge(&GraphEdge {
        stable_id: "e1".to_string(),
        from_node: "file:src/b.ts".to_string(),
        to_node: canonical_scip_id.to_string(),
        kind: EdgeKind::References,
        provider: EvidenceProviderKind::Scip,
        provider_id: Some("scip-typescript".to_string()),
        provider_fingerprint: "mock-digest".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    })
    .unwrap();

    // Also register provider state
    let state = ProviderState {
        identity: ProviderIdentity {
            provider_id: "scip-typescript".to_string(),
            provider_type: ProviderType::Scip,
            provider_version: "0.4.0".to_string(),
            executable_identity: "mock-exec".to_string(),
            scip_schema_version: "0.1.0".to_string(),
        },
        scope: ProviderScope {
            workspace_root: String::new(),
            package: None,
            languages: vec![LanguageId::TypeScript],
        },
        fingerprint: ProviderFingerprint {
            config_fingerprint: "cfg-fp".to_string(),
            digest: "mock-digest".to_string(),
            compiler_version: None,
            executable_identity: "mock-exec".to_string(),
            provider_version: "0.4.0".to_string(),
            scip_schema_version: "0.1.0".to_string(),
        },
        last_successful_run: Some(now_ms()),
        health: ProviderHealth::Available,
        freshness: ProviderFreshness::Fresh,
        output_digest: Some("out-dig".to_string()),
        failure_reason: None,
        semantic_generation: 1,
        last_attempt_fingerprint: None,
        last_attempt_at: None,
        last_attempt_health: None,
        last_attempt_failure_reason: None,
    };
    upsert_provider_state(&tx, &state).unwrap();
    tx.commit().unwrap();

    // Modify AST function computeTotal in src/a.ts
    fs::write(
        &file_a,
        "export function computeTotal(): number { return 100; }
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Verify M4 resolved the AST change to the canonical SCIP node and reached src/b.ts
    let b_target = result.impacted.iter().find(|t| t.target == "src/b.ts");
    assert!(
        b_target.is_some(),
        "M4 must resolve changed AST function to real M3 sem:* SCIP symbol node and reach src/b.ts"
    );

    let prim_path = b_target.unwrap().primary_path.as_ref().unwrap();
    assert_eq!(
        prim_path.seed_node, canonical_scip_id,
        "Seed node must be the canonical M3 SCIP node ID"
    );
}

#[test]
fn test_effective_tsconfig_staleness_passively_detected_in_impact() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("src/a.ts");
    let tsconfig = repo.join("tsconfig.json");

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        &file_a,
        "export function a() {}
",
    )
    .unwrap();
    fs::write(&tsconfig, r#"{"compilerOptions":{"strict":true}}"#).unwrap();
    git_commit_all(repo, "initial");

    // Insert DB with Fresh state
    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/a.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 100,
        content_hash: "h1".to_string(),
        mtime_ms: None,
        indexed_at: 1,
    })
    .unwrap();

    let config_fp = fdx::intelligence::semantic::provider::fingerprint_config_files(
        repo,
        &[Path::new("tsconfig.json")],
    )
    .unwrap();

    let state = ProviderState {
        identity: ProviderIdentity {
            provider_id: "scip-typescript".to_string(),
            provider_type: ProviderType::Scip,
            provider_version: "0.4.0".to_string(),
            executable_identity: "mock-exec".to_string(),
            scip_schema_version: "0.1.0".to_string(),
        },
        scope: ProviderScope {
            workspace_root: String::new(),
            package: None,
            languages: vec![LanguageId::TypeScript],
        },
        fingerprint: ProviderFingerprint {
            config_fingerprint: config_fp,
            digest: "mock-digest".to_string(),
            compiler_version: None,
            executable_identity: "mock-exec".to_string(),
            provider_version: "0.4.0".to_string(),
            scip_schema_version: "0.1.0".to_string(),
        },
        last_successful_run: Some(now_ms()),
        health: ProviderHealth::Available,
        freshness: ProviderFreshness::Fresh,
        output_digest: Some("out-dig".to_string()),
        failure_reason: None,
        semantic_generation: 1,
        last_attempt_fingerprint: None,
        last_attempt_at: None,
        last_attempt_health: None,
        last_attempt_failure_reason: None,
    };
    upsert_provider_state(&tx, &state).unwrap();
    tx.commit().unwrap();

    // Now modify tsconfig.json on disk WITHOUT refreshing semantic database
    fs::write(
        &tsconfig,
        r#"{"compilerOptions":{"strict":false,"target":"es2022"}}"#,
    )
    .unwrap();
    fs::write(
        &file_a,
        "export function a(): number { return 1; }
",
    )
    .unwrap();

    // Run impact-v2
    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Must passively detect effective provider staleness!
    assert!(
        result.uncertainty.iter().any(|u| u.code() == "provider_stale"),
        "Effective tsconfig change must passively emit ProviderStale uncertainty without process execution"
    );
    assert_ne!(
        result.assurance,
        AssuranceLevel::Exact,
        "Stale provider must prevent EXACT assurance"
    );
}
