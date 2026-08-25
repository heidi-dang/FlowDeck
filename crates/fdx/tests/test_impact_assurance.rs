//! Milestone 4 assurance and seed strength propagation tests.

use fdx::intelligence::change::classify::classify_changes;
use fdx::intelligence::change::model::SemanticChangeKind;
use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
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
fn test_tree_sitter_structural_classification_is_degraded_not_exact() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let ts_file = repo.join("calc.ts");
    fs::write(
        &ts_file,
        "export function add(a: number, b: number): number { return a + b; }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Modify body
    fs::write(
        &ts_file,
        "export function add(a: number, b: number): number { return a + b + 0; }
",
    )
    .unwrap();

    let change_set = classify_changes(repo, Some("HEAD"), None).unwrap();
    assert_eq!(change_set.changes.len(), 1);
    let ch = &change_set.changes[0];
    assert_eq!(ch.change_kind, SemanticChangeKind::ImplementationChanged);

    // Invariant 1: Tree-sitter / Structural classification must NOT be labeled EXACT
    assert_ne!(
        ch.assurance,
        AssuranceLevel::Exact,
        "Tree-sitter AST classification must not be labeled EXACT"
    );
    assert_eq!(
        ch.assurance,
        AssuranceLevel::Degraded,
        "Structural AST classification must be Degraded"
    );
    assert_ne!(
        change_set.assurance,
        AssuranceLevel::Exact,
        "Overall ChangeSet assurance for structural changes must not be EXACT"
    );
}

#[test]
fn test_impact_seed_strength_propagation_structural_plus_precise_edge() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("service.ts");
    let file_b = repo.join("controller.ts");
    let tsconfig = repo.join("tsconfig.json");

    fs::write(
        &file_a,
        "export function execute(): void { console.log('v1'); }
",
    )
    .unwrap();
    fs::write(
        &file_b,
        "import { execute } from './service';
export function handle() { execute(); }
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

    use fdx::intelligence::semantic::provider::SemanticProvider;
    let ts_provider = fdx::intelligence::semantic::scip::ts::ScipTypescriptProvider::new();
    let fp = ts_provider
        .passive_fingerprint(repo, Some("0.4.0"))
        .unwrap();

    // Seed database with Precise SCIP edge from controller -> execute
    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "service.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 100,
        content_hash: "h1".to_string(),
        mtime_ms: None,
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "controller.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 100,
        content_hash: "h2".to_string(),
        mtime_ms: None,
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: "sym:service.ts:execute".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("service.ts".to_string()),
        symbol_identity: Some("execute".to_string()),
        package_identity: None,
        metadata: Some(r#"{"display_name":"execute"}"#.to_string()),
        source_identity: None,
    })
    .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: "file:controller.ts".to_string(),
        kind: NodeKind::File,
        canonical_path: Some("controller.ts".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
        source_identity: None,
    })
    .unwrap();
    tx.insert_edge(&GraphEdge {
        stable_id: "e1".to_string(),
        from_node: "file:controller.ts".to_string(),
        to_node: "sym:service.ts:execute".to_string(),
        kind: EdgeKind::Calls,
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

    let state = fdx::intelligence::semantic::provider::ProviderState {
        identity: fdx::intelligence::semantic::provider::ProviderIdentity {
            provider_id: "scip-typescript".to_string(),
            provider_type: fdx::intelligence::semantic::provider::ProviderType::Scip,
            provider_version: "0.4.0".to_string(),
            executable_identity: exec_digest.clone(),
            scip_schema_version: "0.1.0".to_string(),
        },
        scope: fdx::intelligence::semantic::provider::ProviderScope {
            workspace_root: String::new(),
            package: None,
            languages: vec![fdx::intelligence::semantic::LanguageId::TypeScript],
        },
        fingerprint: fp,
        last_successful_run: Some(fdx::intelligence::semantic::provider::now_ms()),
        health: fdx::intelligence::semantic::health::ProviderHealth::Available,
        freshness: fdx::intelligence::semantic::health::ProviderFreshness::Fresh,
        output_digest: Some("out-dig".to_string()),
        failure_reason: None,
        semantic_generation: 1,
        last_attempt_fingerprint: None,
        last_attempt_at: None,
        last_attempt_health: None,
        last_attempt_failure_reason: None,
    };
    fdx::intelligence::semantic::state::upsert_provider_state(&tx, &state).unwrap();
    tx.commit().unwrap();

    // Now change body of execute in service.ts (Structural change)
    fs::write(
        &file_a,
        "export function execute(): void { console.log('v2'); }
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // The change itself is Structural
    // The traversal edge is Precise
    // Therefore, target controller.ts path_strength must be min(Structural, Precise) = Structural!
    let controller_target = result
        .impacted
        .iter()
        .find(|t| t.target == "controller.ts")
        .unwrap();
    assert_eq!(
        controller_target.strength,
        EvidenceStrength::Structural,
        "Target strength must be Structural when change is Structural even if edge is Precise"
    );
    assert_eq!(
        controller_target
            .primary_path
            .as_ref()
            .unwrap()
            .path_strength,
        EvidenceStrength::Structural,
        "Path strength must be min(change strength, edge strength)"
    );
    assert_ne!(
        result.assurance,
        AssuranceLevel::Exact,
        "Impact result assurance must not be EXACT when change is Structural"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}
