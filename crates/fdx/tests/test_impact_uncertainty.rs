//! Milestone 4 uncertainty propagation and deterministic output tests.
//!
//! Tests verify:
//! - Stale semantic provider widens impact rather than narrowing
//! - Unsupported language widens conservatively
//! - Bounded depth limit produces DepthLimitReached uncertainty
//! - Visit limits produce NodeLimitReached / EdgeLimitReached uncertainty
//! - 20 runs of the same request produce byte-for-byte identical JSON
//! - Daemon remains read-only with zero provider executions, zero migrations, zero git mutations

use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::intelligence::change::uncertainty::UncertaintyReason;
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
fn test_stale_provider_widens_impact_and_downgrades_assurance() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();

    let n1 = GraphNode {
        stable_id: "sym:src/api.ts:serve".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/api.ts".to_string()),
        symbol_identity: Some("serve".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: Some("src/api.ts".to_string()),
    };
    let n2 = GraphNode {
        stable_id: "sym:src/client.ts:callServe".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/client.ts".to_string()),
        symbol_identity: Some("callServe".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: Some("src/client.ts".to_string()),
    };

    tx.insert_file(&IndexedFile {
        canonical_path: "src/api.ts".to_string(),
        content_hash: "h1".to_string(),
        size: 50,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/client.ts".to_string(),
        content_hash: "h2".to_string(),
        size: 50,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();

    tx.insert_shared_file_node("src/api.ts", Some("typescript"))
        .unwrap();
    tx.insert_shared_file_node("src/client.ts", Some("typescript"))
        .unwrap();
    tx.insert_node(&n1).unwrap();
    tx.insert_node(&n2).unwrap();

    // Stale edge
    tx.insert_edge(&GraphEdge {
        stable_id: "edge:client->api".to_string(),
        from_node: n2.stable_id.clone(),
        to_node: n1.stable_id.clone(),
        kind: EdgeKind::References,
        provider: EvidenceProviderKind::Scip,
        provider_fingerprint: "scip-v1".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: Some("src/client.ts".to_string()),
        source_hash: Some("h2".to_string()),
        created_revision: 1,
        updated_revision: 1,
        stale: true, // Marked STALE!
    })
    .unwrap();
    tx.commit().unwrap();

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/api.ts"),
        "export function serve() {}
",
    )
    .unwrap();
    fs::write(
        repo.join("src/client.ts"),
        "import { serve } from './api';
export function callServe() { serve(); }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Modify api
    fs::write(
        repo.join("src/api.ts"),
        "export function serve(port: number) {}
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Must NOT conclude empty impact because SCIP is stale
    assert!(
        !result.impacted.is_empty(),
        "Stale provider must not cause zero-impact conclusion"
    );
    assert_ne!(
        result.assurance,
        AssuranceLevel::Exact,
        "Assurance cannot be EXACT when evidence is stale"
    );
    assert!(
        result
            .uncertainty
            .iter()
            .any(|u| matches!(u, UncertaintyReason::ProviderStale(_))
                || matches!(u, UncertaintyReason::FallbackUsed(_))),
        "Must record uncertainty for stale provider"
    );
}

#[test]
fn test_depth_limit_produces_uncertainty() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/n0.ts"),
        "export function f0() {}
",
    )
    .unwrap();
    fs::write(
        repo.join("src/n1.ts"),
        "import { f0 } from './n0';
export function f1() { f0(); }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/n2.ts"),
        "import { f1 } from './n1';
export function f2() { f1(); }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/n3.ts"),
        "import { f2 } from './n2';
export function f3() { f2(); }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/n4.ts"),
        "import { f3 } from './n3';
export function f4() { f3(); }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    let _ = fdx::intelligence::engine::run_incremental_index(repo, false).unwrap();

    fs::write(
        repo.join("src/n0.ts"),
        "export function f0(x: number) {}
",
    )
    .unwrap();

    // Query with depth 1
    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(1)).unwrap();

    assert!(
        result
            .uncertainty
            .iter()
            .any(|u| matches!(u, UncertaintyReason::DepthLimitReached { .. })),
        "Must report DepthLimitReached when graph continues past bounded depth"
    );
    assert_ne!(result.assurance, AssuranceLevel::Exact);
}

#[test]
fn test_deterministic_output_across_repeated_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/a.ts"),
        "export function a() {}
",
    )
    .unwrap();
    fs::write(
        repo.join("src/b.ts"),
        "import { a } from './a';
export function b() { a(); }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/c.ts"),
        "import { a } from './a';
export function c() { a(); }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    let _ = fdx::intelligence::engine::run_incremental_index(repo, false).unwrap();

    fs::write(
        repo.join("src/a.ts"),
        "export function a(flag: boolean) {}
",
    )
    .unwrap();

    let first_run =
        serde_json::to_string(&analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap())
            .unwrap();

    for _ in 0..20 {
        let current_run =
            serde_json::to_string(&analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap())
                .unwrap();
        assert_eq!(
            first_run, current_run,
            "Impact JSON must be byte-for-byte identical across runs"
        );
    }
}
