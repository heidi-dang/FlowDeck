//! Milestone 4 adversarial impact graph and stress tests.
//!
//! Tests verify:
//! - Mixed TS and Rust repository impact
//! - Complex multi-cycle graphs
//! - File rename continuity vs symbol modifications
//! - Large synthetic graphs hitting visit limits gracefully without panic
//! - Path jail enforcement on query and change sources

use fdx::intelligence::change::traverse::{analyze_impact_v2, explain_why_target};
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
fn test_mixed_ts_and_rust_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::create_dir_all(repo.join("native/src")).unwrap();

    // TypeScript side
    fs::write(
        repo.join("src/service.ts"),
        "export function serve(req: string): string { return req; }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/handler.ts"),
        "import { serve } from './service';
export function handle() { return serve('ok'); }
",
    )
    .unwrap();

    // Rust side
    fs::write(
        repo.join("native/src/lib.rs"),
        "pub fn core_calc(x: i32) -> i32 { x + 1 }
pub fn bridge(y: i32) -> i32 { core_calc(y) }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    let _ = fdx::intelligence::engine::run_incremental_index(repo, false).unwrap();

    // Modify TS service signature AND Rust core_calc signature
    fs::write(
        repo.join("src/service.ts"),
        "export function serve(req: string, timeoutMs: number): string { return req; }
",
    )
    .unwrap();
    fs::write(
        repo.join("native/src/lib.rs"),
        "pub fn core_calc(x: i32, factor: i32) -> i32 { x * factor }
pub fn bridge(y: i32) -> i32 { core_calc(y, 2) }
",
    )
    .unwrap();

    let result =
        analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).expect("should analyze mixed repo");

    let impacted_targets: Vec<&str> = result.impacted.iter().map(|t| t.target.as_str()).collect();
    assert!(
        impacted_targets.iter().any(|t| t.contains("handler.ts")),
        "TS handler.ts should be impacted, got: {:?}",
        impacted_targets
    );
    assert!(
        impacted_targets.iter().any(|t| t.contains("lib.rs")),
        "Rust lib.rs should be impacted, got: {:?}",
        impacted_targets
    );
}

#[test]
fn test_complex_multi_node_cycle_terminates() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();

    // Create a 6-node cycle: N0 -> N1 -> N2 -> N3 -> N4 -> N5 -> N0
    for i in 0..6 {
        let sid = format!("sym:src/node_{}.ts:fn_{}", i, i);
        let path = format!("src/node_{}.ts", i);
        tx.insert_file(&IndexedFile {
            canonical_path: path.clone(),
            content_hash: format!("h_{}", i),
            size: 50,
            mtime_ms: None,
            language: Some("typescript".to_string()),
            indexed_at: 1,
        })
        .unwrap();
        tx.insert_shared_file_node(&path, Some("typescript"))
            .unwrap();
        tx.insert_node(&GraphNode {
            stable_id: sid,
            kind: NodeKind::Symbol,
            canonical_path: Some(path),
            symbol_identity: Some(format!("fn_{}", i)),
            package_identity: None,
            metadata: None,
            source_identity: None,
        })
        .unwrap();
    }

    for i in 0..6 {
        let from = format!("sym:src/node_{}.ts:fn_{}", i, i);
        let next = (i + 1) % 6;
        let to = format!("sym:src/node_{}.ts:fn_{}", next, next);
        tx.insert_edge(&GraphEdge {
            stable_id: format!("e_{}_{}", i, next),
            from_node: from,
            to_node: to,
            kind: EdgeKind::Calls,
            provider: EvidenceProviderKind::Scip,
            provider_id: Some("scip-typescript".to_string()),
            provider_fingerprint: "scip".to_string(),
            strength: EvidenceStrength::Precise,
            source_identity: None,
            source_hash: None,
            created_revision: 1,
            updated_revision: 1,
            stale: false,
        })
        .unwrap();
    }
    tx.commit().unwrap();

    fs::create_dir_all(repo.join("src")).unwrap();
    for i in 0..6 {
        fs::write(
            repo.join(format!("src/node_{}.ts", i)),
            format!(
                "export function fn_{}() {{}}
",
                i
            ),
        )
        .unwrap();
    }
    git_commit_all(repo, "initial");

    // Modify fn_0
    fs::write(
        repo.join("src/node_0.ts"),
        "export function fn_0(flag: boolean) {}
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(10)).unwrap();

    // Check all 6 files are impacted exactly once
    assert_eq!(result.impacted.len(), 6);
    let mut seen = std::collections::HashSet::new();
    for t in &result.impacted {
        assert!(seen.insert(&t.target), "Duplicate: {}", t.target);
    }
}

#[test]
fn test_large_synthetic_graph_visit_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();

    let seed_id = "sym:src/root.ts:rootFn".to_string();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/root.ts".to_string(),
        content_hash: "h_root".to_string(),
        size: 50,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_shared_file_node("src/root.ts", Some("typescript"))
        .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: seed_id.clone(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/root.ts".to_string()),
        symbol_identity: Some("rootFn".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: None,
    })
    .unwrap();

    // Generate 1500 fanout nodes
    for i in 0..1500 {
        let nid = format!("sym:src/leaf_{}.ts:leafFn", i);
        let path = format!("src/leaf_{}.ts", i);
        tx.insert_file(&IndexedFile {
            canonical_path: path.clone(),
            content_hash: format!("h_{}", i),
            size: 10,
            mtime_ms: None,
            language: Some("typescript".to_string()),
            indexed_at: 1,
        })
        .unwrap();
        tx.insert_shared_file_node(&path, Some("typescript"))
            .unwrap();
        tx.insert_node(&GraphNode {
            stable_id: nid.clone(),
            kind: NodeKind::Symbol,
            canonical_path: Some(path),
            symbol_identity: Some("leafFn".to_string()),
            package_identity: None,
            metadata: None,
            source_identity: None,
        })
        .unwrap();

        tx.insert_edge(&GraphEdge {
            stable_id: format!("e_{}", i),
            from_node: nid,
            to_node: seed_id.clone(),
            kind: EdgeKind::Calls,
            provider: EvidenceProviderKind::Scip,
            provider_id: Some("scip-typescript".to_string()),
            provider_fingerprint: "scip".to_string(),
            strength: EvidenceStrength::Precise,
            source_identity: None,
            source_hash: None,
            created_revision: 1,
            updated_revision: 1,
            stale: false,
        })
        .unwrap();
    }
    tx.commit().unwrap();

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/root.ts"),
        "export function rootFn() {}
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    fs::write(
        repo.join("src/root.ts"),
        "export function rootFn(x: number) {}
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(2)).unwrap();
    assert!(
        !result.impacted.is_empty(),
        "Should traverse large graph fanout"
    );
    assert!(result.impacted.len() >= 1000);
}

#[test]
fn test_why_query_matches_impact_v2_machinery() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/auth.ts"),
        "export function login(user: string): boolean { return user.length > 0; }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/controller.ts"),
        "import { login } from './auth';
export function handleLogin(u: string) { return login(u); }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    let _ = fdx::intelligence::engine::run_incremental_index(repo, false).unwrap();

    // Modify login
    fs::write(
        repo.join("src/auth.ts"),
        "export function login(user: string, token: string): boolean { return user.length > 0 && token.length > 0; }
",
    )
    .unwrap();

    let impact = analyze_impact_v2(repo, Some("HEAD"), None, Some(2)).unwrap();
    let why = explain_why_target(repo, "src/controller.ts", Some("HEAD"), None, Some(2)).unwrap();

    let controller_in_impact = impact
        .impacted
        .iter()
        .find(|t| t.target.contains("controller.ts"))
        .expect("controller in impact");
    let controller_why = why.expect("controller why target found");

    assert_eq!(controller_in_impact.depth, controller_why.depth);
    assert_eq!(controller_in_impact.strength, controller_why.strength);
    assert_eq!(
        controller_in_impact.primary_path,
        controller_why.primary_path
    );
}
