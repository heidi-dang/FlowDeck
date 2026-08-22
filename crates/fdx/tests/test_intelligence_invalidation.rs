use fdx::intelligence::db::EvidenceDatabase;
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::invalidation::InvalidationEngine;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::protocol::{EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
use tempfile::tempdir;

#[test]
fn test_invalidation() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let mut db = EvidenceDatabase::open(
        repo_root,
        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
    )
    .unwrap();

    let file = IndexedFile {
        canonical_path: "src/main.rs".to_string(),
        content_hash: "hash123".to_string(),
        size: 100,
        mtime_ms: None,
        language: None,
        indexed_at: 0,
    };

    let node1 = GraphNode {
        stable_id: "node1".to_string(),
        kind: NodeKind::File,
        canonical_path: Some("src/main.rs".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
        source_identity: None,
    };

    let edge = GraphEdge {
        stable_id: "edge1".to_string(),
        from_node: "node1".to_string(),
        to_node: "node1".to_string(),
        kind: EdgeKind::Calls,
        provider: EvidenceProviderKind::TreeSitter,
        provider_fingerprint: "ts1".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    };

    {
        let tx = TransactionalGraph::new(&mut db.conn).unwrap();
        tx.insert_file(&file).unwrap();
        tx.insert_node(&node1).unwrap();
        tx.insert_edge(&edge).unwrap();
        tx.commit().unwrap();
    }

    // Invalidate provider with different fingerprint
    let invalidated =
        InvalidationEngine::invalidate_provider(&db.conn, "tree_sitter", "ts2").unwrap();
    assert_eq!(invalidated, 1);

    // Check stale
    let is_stale: bool = db
        .conn
        .query_row(
            "SELECT stale FROM edges WHERE stable_id = 'edge1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(is_stale);

    // Delete stale edges
    InvalidationEngine::delete_stale_edges(&db.conn).unwrap();
    let edge_count: i32 = db
        .conn
        .query_row("SELECT count(*) FROM edges", [], |r| r.get(0))
        .unwrap();
    assert_eq!(edge_count, 0);

    // File deletion cascade
    tx_insert(&mut db);
    InvalidationEngine::delete_file(&db.conn, "src/main.rs").unwrap();
    let node_count: i32 = db
        .conn
        .query_row("SELECT count(*) FROM nodes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(node_count, 0);
}

fn tx_insert(db: &mut EvidenceDatabase) {
    let file = IndexedFile {
        canonical_path: "src/main.rs".to_string(),
        content_hash: "hash123".to_string(),
        size: 100,
        mtime_ms: None,
        language: None,
        indexed_at: 0,
    };
    let node1 = GraphNode {
        stable_id: "node1".to_string(),
        kind: NodeKind::File,
        canonical_path: Some("src/main.rs".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
        source_identity: None,
    };
    let edge = GraphEdge {
        stable_id: "edge1".to_string(),
        from_node: "node1".to_string(),
        to_node: "node1".to_string(),
        kind: EdgeKind::Calls,
        provider: EvidenceProviderKind::TreeSitter,
        provider_fingerprint: "ts1".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    };
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&file).unwrap();
    tx.insert_node(&node1).unwrap();
    tx.insert_edge(&edge).unwrap();
    tx.commit().unwrap();
}
#[test]
fn check_provider_string() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let mut db = EvidenceDatabase::open(
        repo_root,
        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
    )
    .unwrap();

    let edge = GraphEdge {
        stable_id: "edge_check".to_string(),
        from_node: "node1".to_string(),
        to_node: "node1".to_string(),
        kind: EdgeKind::Calls,
        provider: EvidenceProviderKind::TreeSitter,
        provider_fingerprint: "ts1".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    };

    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_node(&GraphNode {
        stable_id: "node1".to_string(),
        kind: NodeKind::File,
        canonical_path: None,
        symbol_identity: None,
        package_identity: None,
        metadata: None,
        source_identity: None,
    })
    .unwrap();
    tx.insert_edge(&edge).unwrap();
    tx.commit().unwrap();

    let provider: String = db
        .conn
        .query_row(
            "SELECT provider FROM edges WHERE stable_id = 'edge_check'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    println!("STORED_PROVIDER: '{}'", provider);
    assert_eq!(provider, "tree_sitter");
}
