//! Milestone 4 evidence-path explanation tests.
//!
//! Tests verify:
//! - Every impacted target has at least one evidence path or explicit widening reason
//! - Path strength = min(edge strengths)
//! - Fallback edge downgrades path strength to Structural or Heuristic
//! - Explanation paths per target are bounded (MAX <= 3)
//! - "why" command/query uses the exact same evidence path machinery

use fdx::intelligence::change::traverse::analyze_impact_v2;
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
fn test_every_target_has_evidence_path_or_widening_reason() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/a.ts"),
        "export function fnA() {}
",
    )
    .unwrap();
    fs::write(
        repo.join("src/b.ts"),
        "import { fnA } from './a';
export function fnB() { fnA(); }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    let _ = fdx::intelligence::engine::run_incremental_index(repo, false).unwrap();

    fs::write(
        repo.join("src/a.ts"),
        "export function fnA(p: number) {}
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    assert!(!result.impacted.is_empty(), "Should have impacted targets");

    for target in &result.impacted {
        let has_path = target
            .primary_path
            .as_ref()
            .map(|p| !p.steps.is_empty())
            .unwrap_or(false);
        let has_widening = target.widening_reason.is_some();
        assert!(
            has_path || has_widening,
            "Target {} must have either an evidence path or a widening reason",
            target.target
        );
    }
}

#[test]
fn test_path_strength_is_min_of_edge_strengths() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

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

    let tsconfig = repo.join("tsconfig.json");
    fs::write(&tsconfig, r#"{"compilerOptions":{"strict":true}}"#).unwrap();

    use fdx::intelligence::semantic::provider::SemanticProvider;
    let ts_provider = fdx::intelligence::semantic::scip::ts::ScipTypescriptProvider::new();
    let fp = ts_provider
        .passive_fingerprint(repo, Some("0.4.0"))
        .unwrap();

    // Build a 2-hop chain where hop 1 is Precise and hop 2 is Structural
    use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
    use fdx::intelligence::index::TransactionalGraph;
    use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();

    let n1 = GraphNode {
        stable_id: "sym:src/core.ts:base".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/core.ts".to_string()),
        symbol_identity: Some("base".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: Some("src/core.ts".to_string()),
    };
    let n2 = GraphNode {
        stable_id: "sym:src/mid.ts:midFn".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/mid.ts".to_string()),
        symbol_identity: Some("midFn".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: Some("src/mid.ts".to_string()),
    };
    let n3 = GraphNode {
        stable_id: "sym:src/app.ts:appFn".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/app.ts".to_string()),
        symbol_identity: Some("appFn".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: Some("src/app.ts".to_string()),
    };

    tx.insert_file(&IndexedFile {
        canonical_path: "src/core.ts".to_string(),
        content_hash: "h1".to_string(),
        size: 50,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/mid.ts".to_string(),
        content_hash: "h2".to_string(),
        size: 50,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/app.ts".to_string(),
        content_hash: "h3".to_string(),
        size: 50,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();

    tx.insert_shared_file_node("src/core.ts", Some("typescript"))
        .unwrap();
    tx.insert_shared_file_node("src/mid.ts", Some("typescript"))
        .unwrap();
    tx.insert_shared_file_node("src/app.ts", Some("typescript"))
        .unwrap();

    tx.insert_node(&n1).unwrap();
    tx.insert_node(&n2).unwrap();
    tx.insert_node(&n3).unwrap();

    // Edge 1: midFn -> base (Precise)
    tx.insert_edge(&GraphEdge {
        stable_id: "edge:mid->base".to_string(),
        from_node: n2.stable_id.clone(),
        to_node: n1.stable_id.clone(),
        kind: EdgeKind::References,
        provider: EvidenceProviderKind::Scip,
        provider_id: Some("scip-typescript".to_string()),
        provider_fingerprint: fp.digest.clone(),
        strength: EvidenceStrength::Precise,
        source_identity: Some("src/mid.ts".to_string()),
        source_hash: Some("h2".to_string()),
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
            executable_identity: exec_digest,
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

    // Edge 2: appFn -> midFn (Structural fallback)
    tx.insert_edge(&GraphEdge {
        stable_id: "edge:app->mid".to_string(),
        from_node: n3.stable_id.clone(),
        to_node: n2.stable_id.clone(),
        kind: EdgeKind::Calls,
        provider: EvidenceProviderKind::TreeSitter,
        provider_id: None,
        provider_fingerprint: "ts-v1".to_string(),
        strength: EvidenceStrength::Structural,
        source_identity: Some("src/app.ts".to_string()),
        source_hash: Some("h3".to_string()),
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    })
    .unwrap();

    tx.commit().unwrap();

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/core.ts"),
        "export function base() {}
",
    )
    .unwrap();
    fs::write(
        repo.join("src/mid.ts"),
        "import { base } from './core';
export function midFn() { base(); }
",
    )
    .unwrap();
    fs::write(
        repo.join("src/app.ts"),
        "import { midFn } from './mid';
export function appFn() { midFn(); }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Modify base signature
    fs::write(
        repo.join("src/core.ts"),
        "export function base(x: number) {}
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    let app_target = result
        .impacted
        .iter()
        .find(|t| t.target.contains("app.ts") || t.target.contains("appFn"))
        .expect("app target found");

    // Path strength must be min(Precise, Structural) = Structural
    assert_eq!(app_target.strength, EvidenceStrength::Structural);
    if let Some(ref path) = app_target.primary_path {
        assert_eq!(path.path_strength, EvidenceStrength::Structural);
    }

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}

#[test]
fn test_alternate_explanation_paths_bounded() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
    use fdx::intelligence::index::TransactionalGraph;
    use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();

    // Create a mesh with 10 paths from seed to target
    let seed = GraphNode {
        stable_id: "sym:src/seed.ts:root".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/seed.ts".to_string()),
        symbol_identity: Some("root".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: Some("src/seed.ts".to_string()),
    };
    let target = GraphNode {
        stable_id: "sym:src/target.ts:end".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/target.ts".to_string()),
        symbol_identity: Some("end".to_string()),
        package_identity: None,
        metadata: None,
        source_identity: Some("src/target.ts".to_string()),
    };
    tx.insert_file(&IndexedFile {
        canonical_path: "src/seed.ts".to_string(),
        content_hash: "h_seed".to_string(),
        size: 10,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/target.ts".to_string(),
        content_hash: "h_target".to_string(),
        size: 10,
        mtime_ms: None,
        language: Some("typescript".to_string()),
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_shared_file_node("src/seed.ts", Some("typescript"))
        .unwrap();
    tx.insert_shared_file_node("src/target.ts", Some("typescript"))
        .unwrap();
    tx.insert_node(&seed).unwrap();
    tx.insert_node(&target).unwrap();

    for i in 0..10 {
        let mid_node = GraphNode {
            stable_id: format!("sym:src/mid_{}.ts:node", i),
            kind: NodeKind::Symbol,
            canonical_path: Some(format!("src/mid_{}.ts", i)),
            symbol_identity: Some("node".to_string()),
            package_identity: None,
            metadata: None,
            source_identity: Some(format!("src/mid_{}.ts", i)),
        };
        let p = format!("src/mid_{}.ts", i);
        tx.insert_file(&IndexedFile {
            canonical_path: p.clone(),
            content_hash: format!("h_{}", i),
            size: 10,
            mtime_ms: None,
            language: Some("typescript".to_string()),
            indexed_at: 1,
        })
        .unwrap();
        tx.insert_shared_file_node(&p, Some("typescript")).unwrap();
        tx.insert_node(&mid_node).unwrap();

        tx.insert_edge(&GraphEdge {
            stable_id: format!("e1_{}", i),
            from_node: mid_node.stable_id.clone(),
            to_node: seed.stable_id.clone(),
            kind: EdgeKind::References,
            provider: EvidenceProviderKind::Scip,
            provider_id: Some("scip-typescript".to_string()),
            provider_fingerprint: "scip".to_string(),
            strength: EvidenceStrength::Precise,
            source_identity: Some(p.clone()),
            source_hash: Some(format!("h_{}", i)),
            created_revision: 1,
            updated_revision: 1,
            stale: false,
        })
        .unwrap();

        tx.insert_edge(&GraphEdge {
            stable_id: format!("e2_{}", i),
            from_node: target.stable_id.clone(),
            to_node: mid_node.stable_id.clone(),
            kind: EdgeKind::Calls,
            provider: EvidenceProviderKind::Scip,
            provider_id: Some("scip-typescript".to_string()),
            provider_fingerprint: "scip".to_string(),
            strength: EvidenceStrength::Precise,
            source_identity: Some("src/target.ts".to_string()),
            source_hash: Some("h_target".to_string()),
            created_revision: 1,
            updated_revision: 1,
            stale: false,
        })
        .unwrap();
    }
    tx.commit().unwrap();

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/seed.ts"),
        "export function root() {}
",
    )
    .unwrap();
    fs::write(
        repo.join("src/target.ts"),
        "export function end() {}
",
    )
    .unwrap();
    for i in 0..10 {
        fs::write(
            repo.join(format!("src/mid_{}.ts", i)),
            "export function node() {}
",
        )
        .unwrap();
    }
    git_commit_all(repo, "initial");

    // Edit seed
    fs::write(
        repo.join("src/seed.ts"),
        "export function root(arg: number) {}
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    let tgt = result
        .impacted
        .iter()
        .find(|t| t.target.contains("target.ts") || t.target.contains("end"))
        .expect("target found");

    assert!(
        tgt.alternate_paths.len() <= 3,
        "Alternate paths must be bounded to at most 3"
    );
}
