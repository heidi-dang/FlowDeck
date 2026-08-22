//! Milestone 4 semantic edge provider ownership and fingerprint correlation tests.

use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use fdx::intelligence::semantic::provider::{
    now_ms, ProviderIdentity, ProviderScope, ProviderState, ProviderType,
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
fn test_semantic_edge_provider_id_and_fingerprint_correlation() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("src/a.ts");
    let file_b = repo.join("src/b.ts");
    let tsconfig = repo.join("tsconfig.json");

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        &file_a,
        "export function core(): number { return 1; }
",
    )
    .unwrap();
    fs::write(
        &file_b,
        "import { core } from './a';
export function useCore() { return core(); }
",
    )
    .unwrap();
    fs::write(&tsconfig, r#"{"compilerOptions":{"strict":true}}"#).unwrap();
    git_commit_all(repo, "initial");

    let mock_bin = repo.join("mock-scip-ts");
    fs::write(&mock_bin, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&mock_bin, fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);
    let exec_digest =
        fdx::intelligence::semantic::provider::executable_content_digest(&mock_bin).unwrap();

    let canonical_scip_id = "sem:scip-typescript npm @demo/pkg 1.0.0 src/a.ts/core().";

    use fdx::intelligence::semantic::provider::SemanticProvider;
    let ts_provider = fdx::intelligence::semantic::scip::ts::ScipTypescriptProvider::new();
    let fp = ts_provider
        .passive_fingerprint(repo, Some("0.4.0"))
        .unwrap();

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
        symbol_identity: Some("core".to_string()),
        package_identity: Some("pkg:npm/@demo/pkg@1.0.0".to_string()),
        metadata: Some(r#"{"display_name":"core","scip_kind":17}"#.to_string()),
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

    // Insert edge with explicit provider_id: "scip-typescript"
    tx.insert_edge(&GraphEdge {
        stable_id: "e1".to_string(),
        from_node: "file:src/b.ts".to_string(),
        to_node: canonical_scip_id.to_string(),
        kind: EdgeKind::References,
        provider: EvidenceProviderKind::Scip,
        provider_id: Some("scip-typescript".to_string()),
        provider_fingerprint: fp.digest.clone(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    })
    .unwrap();

    let state = ProviderState {
        identity: ProviderIdentity {
            provider_id: "scip-typescript".to_string(),
            provider_type: ProviderType::Scip,
            provider_version: "0.4.0".to_string(),
            executable_identity: exec_digest.clone(),
            scip_schema_version: "0.1.0".to_string(),
        },
        scope: ProviderScope {
            workspace_root: String::new(),
            package: None,
            languages: vec![LanguageId::TypeScript],
        },
        fingerprint: fp,
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

    // 1. Case A: provider is Fresh and fingerprints match -> edge is current!
    fs::write(
        &file_a,
        "export function core(): number { return 2; }
",
    )
    .unwrap();
    let res = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    let b_target = res.impacted.iter().find(|t| t.target == "src/b.ts");
    assert!(b_target.is_some());
    assert!(!res.uncertainty.iter().any(|u| u.code() == "provider_stale"));

    // 2. Case B: provider fingerprint changes (tsconfig modified) -> edge is detected stale via provider_id correlation!
    fs::write(&tsconfig, r#"{"compilerOptions":{"strict":false}}"#).unwrap();
    let res_stale = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    assert!(
        res_stale
            .uncertainty
            .iter()
            .any(|u| u.code() == "provider_stale"),
        "Edge must be correlated with provider_id 'scip-typescript' and detected stale"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}

#[test]
fn test_unknown_provider_ownership_edge_fails_closed_and_widens() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("src/a.ts");
    let file_b = repo.join("src/b.ts");

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        &file_a,
        "export function foo(): void {}
",
    )
    .unwrap();
    fs::write(
        &file_b,
        "import { foo } from './a';
export function bar() { foo(); }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

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
        stable_id: "sym:src/a.ts:foo".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/a.ts".to_string()),
        symbol_identity: Some("foo".to_string()),
        package_identity: None,
        metadata: Some(r#"{"display_name":"foo"}"#.to_string()),
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

    // Insert legacy edge without provider_id (provider_id is None / NULL)
    tx.insert_edge(&GraphEdge {
        stable_id: "e_legacy".to_string(),
        from_node: "file:src/b.ts".to_string(),
        to_node: "sym:src/a.ts:foo".to_string(),
        kind: EdgeKind::References,
        provider: EvidenceProviderKind::Scip,
        provider_id: None, // Unknown ownership!
        provider_fingerprint: "legacy".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    })
    .unwrap();
    tx.commit().unwrap();

    fs::write(
        &file_a,
        "export function foo(): number { return 1; }
",
    )
    .unwrap();
    let res = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Must detect unknown provider ownership and execute fallback widening
    assert_ne!(
        res.assurance,
        AssuranceLevel::Exact,
        "Unknown provider ownership edge must not yield EXACT assurance"
    );
}
