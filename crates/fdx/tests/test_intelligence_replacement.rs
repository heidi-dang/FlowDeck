use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::protocol::{EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
use tempfile::tempdir;

#[test]
fn test_replace_file_evidence() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();

    let file = IndexedFile {
        canonical_path: "src/a.ts".to_string(),
        content_hash: "hash1".to_string(),
        size: 10,
        mtime_ms: None,
        language: None,
        indexed_at: 0,
    };

    let node_b = GraphNode {
        stable_id: "node_b".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/a.ts".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
        source_identity: None,
    };

    let node_x = GraphNode {
        stable_id: "node_x".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/other.ts".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
        source_identity: None,
    };

    let edge_a_x = GraphEdge {
        stable_id: "edge_a_x".to_string(),
        from_node: "node_b".to_string(),
        to_node: "node_x".to_string(),
        kind: EdgeKind::Calls,
        provider: EvidenceProviderKind::TreeSitter,
        provider_fingerprint: "ts".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: Some("src/a.ts".to_string()),
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    };

    let edge_x_b = GraphEdge {
        stable_id: "edge_x_b".to_string(),
        from_node: "node_x".to_string(),
        to_node: "node_b".to_string(),
        kind: EdgeKind::Calls,
        provider: EvidenceProviderKind::TreeSitter,
        provider_fingerprint: "ts".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: Some("src/other.ts".to_string()),
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    };

    {
        let tx = TransactionalGraph::new(&mut db.conn).unwrap();
        tx.insert_file(&file).unwrap();
        // Insert other file too so FK doesn't fail
        tx.insert_file(&IndexedFile {
            canonical_path: "src/other.ts".to_string(),
            content_hash: "hash2".to_string(),
            size: 10,
            mtime_ms: None,
            language: None,
            indexed_at: 0,
        })
        .unwrap();
        tx.insert_node(&node_b).unwrap();
        tx.insert_node(&node_x).unwrap();
        tx.insert_edge(&edge_a_x).unwrap();
        tx.insert_edge(&edge_x_b).unwrap();
        tx.commit().unwrap();
    }

    // Now replace the file
    let file2 = IndexedFile {
        canonical_path: "src/a.ts".to_string(),
        content_hash: "hash3".to_string(),
        size: 10,
        mtime_ms: None,
        language: None,
        indexed_at: 0,
    };
    {
        let tx = TransactionalGraph::new(&mut db.conn).unwrap();
        tx.insert_file(&file2).unwrap();
        tx.commit().unwrap();
    }

    // node_b should be gone
    let node_count: i32 = db
        .conn
        .query_row(
            "SELECT count(*) FROM nodes WHERE stable_id = 'node_b'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(node_count, 0);

    // node_x should still be there
    let node_x_count: i32 = db
        .conn
        .query_row(
            "SELECT count(*) FROM nodes WHERE stable_id = 'node_x'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(node_x_count, 1);

    // edge_a_x should be gone (cascade from node_b)
    let edge1_count: i32 = db
        .conn
        .query_row(
            "SELECT count(*) FROM edges WHERE stable_id = 'edge_a_x'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(edge1_count, 0);

    // edge_x_b should be gone (cascade from node_b as to_node)
    let edge2_count: i32 = db
        .conn
        .query_row(
            "SELECT count(*) FROM edges WHERE stable_id = 'edge_x_b'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(edge2_count, 0);
}
