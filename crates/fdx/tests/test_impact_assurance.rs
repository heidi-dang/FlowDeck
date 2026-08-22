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
    git_commit_all(repo, "initial");

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
        provider_fingerprint: "scip".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    })
    .unwrap();
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
}
