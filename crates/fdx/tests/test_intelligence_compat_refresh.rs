use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::engine::run_incremental_index;
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::protocol::{EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

fn init_repo(repo: &Path) {
    git(repo, &["init"]);
    git(repo, &["config", "user.name", "test"]);
    git(repo, &["config", "user.email", "t@t.test"]);
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(repo.join("src/foo.ts"), "const a = 1;").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "init"]);
}

fn seed_old_provider_evidence(repo: &Path, provider_fingerprint: &str) {
    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    // Simulate a stored provider contract that changed
    db.conn
        .execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('provider_fingerprint', ?1)",
            rusqlite::params![provider_fingerprint],
        )
        .unwrap();
    {
        let tx = TransactionalGraph::new(&mut db.conn).unwrap();
        tx.insert_file(&IndexedFile {
            canonical_path: "src/foo.ts".to_string(),
            content_hash: "h1".to_string(),
            size: 12,
            mtime_ms: None,
            language: None,
            indexed_at: 0,
        })
        .unwrap();
        tx.insert_node(&GraphNode {
            stable_id: "symbol:oldprov:foo".to_string(),
            kind: NodeKind::Symbol,
            canonical_path: Some("src/foo.ts".to_string()),
            symbol_identity: Some("foo".to_string()),
            package_identity: None,
            metadata: None,
        })
        .unwrap();
        tx.insert_edge(&GraphEdge {
            stable_id: "edge:oldprov:1".to_string(),
            from_node: "symbol:oldprov:foo".to_string(),
            to_node: "symbol:oldprov:foo".to_string(),
            kind: EdgeKind::Calls,
            provider: EvidenceProviderKind::Scip,
            provider_fingerprint: provider_fingerprint.to_string(),
            strength: EvidenceStrength::Precise,
            source_identity: Some("src/foo.ts".to_string()),
            source_hash: Some("h1".to_string()),
            created_revision: 1,
            updated_revision: 1,
            stale: false,
        })
        .unwrap();
        tx.commit().unwrap();
    }
}

#[test]
fn test_provider_fingerprint_mismatch_blocks_false_fresh() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo);
    run_incremental_index(repo, false).unwrap();

    // Simulate provider contract changed: stored fingerprint no longer matches current
    seed_old_provider_evidence(repo, "provider-A");
    let edge_count_before: i64 = {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadOnly).unwrap();
        db.conn
            .query_row("SELECT count(*) FROM edges", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(edge_count_before, 1);

    // Refresh must enforce compatibility BEFORE indexing
    let report = run_incremental_index(repo, false).unwrap();
    assert_eq!(
        report.state.to_string(),
        "degraded",
        "provider refresh unavailable must not report fresh"
    );
    assert!(
        report
            .reasons
            .iter()
            .any(|r| r.contains("provider_refresh_required")),
        "reasons: {:?}",
        report.reasons
    );

    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadOnly).unwrap();
    // Old provider-owned evidence must not survive as current
    let edge_count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM edges", [], |r| r.get(0))
        .unwrap();
    assert_eq!(edge_count, 0, "old provider edges must be invalidated");

    // Old fingerprint must NOT be relabeled current while evidence is absent
    let stored_fp = db.get_metadata("provider_fingerprint").unwrap().unwrap();
    assert_eq!(
        stored_fp, "provider-A",
        "must not relabel old compatibility as current"
    );

    let status = db.get_metadata("status").unwrap().unwrap();
    assert_eq!(status, "DEGRADED");
}

#[test]
fn test_semantic_model_mismatch_blocks_false_fresh() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo);
    run_incremental_index(repo, false).unwrap();

    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT OR REPLACE INTO metadata (key, value) VALUES ('semantic_model_version', '99')",
                [],
            )
            .unwrap();
    }

    let report = run_incremental_index(repo, false).unwrap();
    assert_eq!(report.state.to_string(), "degraded");
    assert!(report
        .reasons
        .iter()
        .any(|r| r.contains("semantic_rebuild_required")));

    // Semantic layer must be wiped; old version must not be relabeled current
    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadOnly).unwrap();
    let sem = db.get_metadata("semantic_model_version").unwrap().unwrap();
    assert_eq!(sem, "99");
    assert_eq!(db.get_metadata("status").unwrap().unwrap(), "DEGRADED");
}

#[test]
fn test_selection_policy_change_keeps_semantic_evidence() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo);
    run_incremental_index(repo, false).unwrap();

    // Seed a semantic node/edge plus an old selection policy version.
    // The file row already exists with its real content hash, so we only
    // add the semantic layer without overwriting file state.
    {
        let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT OR REPLACE INTO metadata (key, value) VALUES ('selection_policy_version', '888')",
                [],
            )
            .unwrap();
        let tx = TransactionalGraph::new(&mut db.conn).unwrap();
        tx.insert_node(&GraphNode {
            stable_id: "symbol:scip:foo".to_string(),
            kind: NodeKind::Symbol,
            canonical_path: Some("src/foo.ts".to_string()),
            symbol_identity: Some("foo".to_string()),
            package_identity: None,
            metadata: None,
        })
        .unwrap();
        tx.insert_edge(&GraphEdge {
            stable_id: "edge:scip:1".to_string(),
            from_node: "symbol:scip:foo".to_string(),
            to_node: "symbol:scip:foo".to_string(),
            kind: EdgeKind::Calls,
            provider: EvidenceProviderKind::Scip,
            provider_fingerprint: "scip-1".to_string(),
            strength: EvidenceStrength::Precise,
            source_identity: Some("src/foo.ts".to_string()),
            source_hash: Some("h1".to_string()),
            created_revision: 1,
            updated_revision: 1,
            stale: false,
        })
        .unwrap();
        tx.commit().unwrap();
    }

    let report = run_incremental_index(repo, false).unwrap();
    assert_eq!(
        report.state.to_string(),
        "fresh",
        "selection policy change must not rebuild semantic graph"
    );

    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadOnly).unwrap();
    let node_count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM nodes", [], |r| r.get(0))
        .unwrap();
    let edge_count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM edges", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        node_count, 1,
        "semantic nodes must survive selection-policy-only change"
    );
    assert_eq!(
        edge_count, 1,
        "semantic edges must survive selection-policy-only change"
    );
}
