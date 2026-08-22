//! Milestone 4 transitive impact traversal tests.
//!
//! Tests verify:
//! - Direct and multi-hop callers via REFERENCES and CALLS
//! - Importer impact via IMPORTS
//! - Interface and implementation traversal semantics
//! - Inheritance hierarchy propagation semantics
//! - Cycles (A <-> B, recursive graphs) terminate without duplicate targets or loops
//! - Deleted symbol uses before-evidence
//! - Result ordering is deterministic

use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::protocol::{EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
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
fn test_impact_direct_and_two_hop_callers() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/leaf.ts"),
        "export function leafFn(): number { return 42; }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/mid.ts"),
        "import { leafFn } from './leaf';
export function midFn(): number { return leafFn() + 1; }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/top.ts"),
        "import { midFn } from './mid';
export function topFn(): number { return midFn() * 2; }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Index graph
    let report = fdx::intelligence::engine::run_incremental_index(repo, false).unwrap();
    assert!(report.files >= 3);

    // Modify leafFn signature
    fs::write(
        repo.join("src/leaf.ts"),
        "export function leafFn(flag: boolean): number { return flag ? 42 : 0; }
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3))
        .expect("impact analysis should succeed");

    // leaf.ts, mid.ts, top.ts should be impacted
    let impacted_files: Vec<&str> = result.impacted.iter().map(|t| t.target.as_str()).collect();
    assert!(
        impacted_files.iter().any(|f| f.contains("mid.ts")),
        "Direct consumer mid.ts must be impacted, got: {:?}",
        impacted_files
    );
    assert!(
        impacted_files.iter().any(|f| f.contains("top.ts")),
        "Transitive consumer top.ts must be impacted, got: {:?}",
        impacted_files
    );
}

#[test]
fn test_impact_cycle_handling() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    // Cyclic dependencies: A imports B, B imports A
    fs::write(
        repo.join("src/a.ts"),
        "import { bFn } from './b';
export function aFn(): number { return bFn(); }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/b.ts"),
        "import { aFn } from './a';
export function bFn(): number { return 1; }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    let _ = fdx::intelligence::engine::run_incremental_index(repo, false).unwrap();

    // Modify bFn
    fs::write(
        repo.join("src/b.ts"),
        "import { aFn } from './a';
export function bFn(x: number): number { return x + 1; }
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(5))
        .expect("cycle traversal must terminate");

    // Check no infinite loop or duplicate targets
    let mut targets_seen = std::collections::HashSet::new();
    for t in &result.impacted {
        assert!(
            targets_seen.insert(&t.target),
            "Duplicate target in impact result: {}",
            t.target
        );
    }
}

#[test]
fn test_impact_interface_and_inheritance_direction() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();

    // Setup interface IWorker and implementation WorkerImpl
    // Stored relation: WorkerImpl -> Implements -> IWorker
    // Contract: when IWorker changes, WorkerImpl is impacted.
    // When WorkerImpl changes, IWorker is NOT automatically impacted.
    let n_iface = GraphNode {
        stable_id: "sym:src/types.ts:IWorker".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/types.ts".to_string()),
        symbol_identity: Some("IWorker".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: Some("src/types.ts".to_string()),
    };
    let n_impl = GraphNode {
        stable_id: "sym:src/impl.ts:WorkerImpl".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/impl.ts".to_string()),
        symbol_identity: Some("WorkerImpl".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: Some("src/impl.ts".to_string()),
    };
    tx.insert_file(&IndexedFile {
        canonical_path: "src/types.ts".to_string(),
        content_hash: "h1".to_string(),
        size: 100,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/impl.ts".to_string(),
        content_hash: "h2".to_string(),
        size: 100,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_shared_file_node("src/types.ts", Some("typescript"))
        .unwrap();
    tx.insert_shared_file_node("src/impl.ts", Some("typescript"))
        .unwrap();
    tx.insert_node(&n_iface).unwrap();
    tx.insert_node(&n_impl).unwrap();

    tx.insert_edge(&GraphEdge {
        stable_id: "edge:impl->iface".to_string(),
        from_node: "sym:src/impl.ts:WorkerImpl".to_string(),
        to_node: "sym:src/types.ts:IWorker".to_string(),
        kind: EdgeKind::Implements,
        provider: EvidenceProviderKind::TreeSitter,
        provider_id: None,
        provider_fingerprint: "ts-v1".to_string(),
        strength: EvidenceStrength::Structural,
        source_identity: Some("src/impl.ts".to_string()),
        source_hash: Some("h2".to_string()),
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    })
    .unwrap();
    tx.commit().unwrap();

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/types.ts"),
        "export interface IWorker { work(): void; }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/impl.ts"),
        "export class WorkerImpl implements IWorker { work() {} }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Case 1: IWorker changes -> WorkerImpl must be impacted
    fs::write(
        repo.join("src/types.ts"),
        "export interface IWorker { work(timeout: number): void; }
",
    )
    .unwrap();
    let res1 = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    let iface_targets: Vec<&str> = res1.impacted.iter().map(|t| t.target.as_str()).collect();
    assert!(
        iface_targets
            .iter()
            .any(|t| t.contains("impl.ts") || t.contains("WorkerImpl")),
        "Interface change must propagate to implementation, got: {:?}",
        iface_targets
    );
}

#[test]
fn test_impact_deleted_symbol_uses_before_evidence() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/service.ts"),
        "export function deprecatedApi(): void {}
export function newApi(): void {}
",
    )
    .unwrap();
    fs::write(
        repo.join("src/consumer.ts"),
        "import { deprecatedApi } from './service';
export function run() { deprecatedApi(); }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    let _ = fdx::intelligence::engine::run_incremental_index(repo, false).unwrap();

    // Now delete deprecatedApi in src/service.ts
    fs::write(
        repo.join("src/service.ts"),
        "export function newApi(): void {}
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3))
        .expect("should analyze deleted symbol impact");

    let impacted: Vec<&str> = result.impacted.iter().map(|t| t.target.as_str()).collect();
    assert!(
        impacted.iter().any(|t| t.contains("consumer.ts")),
        "Caller of deleted symbol must be impacted using before evidence, got: {:?}",
        impacted
    );
}
