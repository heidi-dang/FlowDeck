use fdx::intelligence::db::EvidenceDatabase;
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::protocol::{EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
use tempfile::tempdir;

#[test]
fn test_transactional_insert_and_commit() {
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
        mtime_ms: Some(1000),
        language: Some("rust".to_string()),
        indexed_at: 2000,
    };

    let node1 = GraphNode {
        stable_id: "node1".to_string(),
        kind: NodeKind::File,
        canonical_path: Some("src/main.rs".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
    };

    let node2 = GraphNode {
        stable_id: "node2".to_string(),
        kind: NodeKind::File,
        canonical_path: Some("src/main.rs".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
    };

    let edge = GraphEdge {
        stable_id: "edge1".to_string(),
        from_node: "node1".to_string(),
        to_node: "node2".to_string(),
        kind: EdgeKind::Calls,
        provider: EvidenceProviderKind::TreeSitter,
        provider_fingerprint: "ast1".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    };

    // Test commit
    {
        let tx = TransactionalGraph::new(&mut db.conn).unwrap();
        tx.insert_file(&file).unwrap();
        tx.insert_node(&node1).unwrap();
        tx.insert_node(&node2).unwrap();
        tx.insert_edge(&edge).unwrap();
        tx.commit().unwrap();
    }

    // Verify
    let count: i32 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let edge_count: i32 = db
        .conn
        .query_row("SELECT count(*) FROM edges", [], |r| r.get(0))
        .unwrap();
    assert_eq!(edge_count, 1);
}

#[test]
fn test_transactional_rollback() {
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
        mtime_ms: Some(1000),
        language: Some("rust".to_string()),
        indexed_at: 2000,
    };

    // Test rollback
    {
        let tx = TransactionalGraph::new(&mut db.conn).unwrap();
        tx.insert_file(&file).unwrap();
        tx.rollback().unwrap();
    }

    // Verify
    let count: i32 = db
        .conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_foreign_key_cascade() {
    let dir = tempfile::tempdir().unwrap();
    let repo_root = dir.path();
    let mut db = EvidenceDatabase::open(
        repo_root,
        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
    )
    .unwrap();

    // Verify PRAGMA foreign_keys is ON
    let fk_enabled: i32 = db
        .conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk_enabled, 1);

    let file = IndexedFile {
        canonical_path: "src/a.ts".to_string(),
        content_hash: "hash".to_string(),
        size: 10,
        mtime_ms: None,
        language: None,
        indexed_at: 0,
    };
    let node = GraphNode {
        stable_id: "node_a".to_string(),
        kind: NodeKind::File,
        canonical_path: Some("src/a.ts".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
    };
    let edge = GraphEdge {
        stable_id: "edge_a".to_string(),
        from_node: "node_a".to_string(),
        to_node: "node_a".to_string(),
        kind: EdgeKind::Calls,
        provider: EvidenceProviderKind::TreeSitter,
        provider_fingerprint: "ts".to_string(),
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
        tx.insert_node(&node).unwrap();
        tx.insert_edge(&edge).unwrap();
        tx.commit().unwrap();
    }

    // Delete the file using a direct SQL to trigger CASCADE
    db.conn
        .execute("DELETE FROM files WHERE canonical_path = 'src/a.ts'", [])
        .unwrap();

    // Node should be deleted by cascade
    let node_count: i32 = db
        .conn
        .query_row("SELECT count(*) FROM nodes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(node_count, 0, "Node should cascade delete");

    // Edge should be deleted by cascade
    let edge_count: i32 = db
        .conn
        .query_row("SELECT count(*) FROM edges", [], |r| r.get(0))
        .unwrap();
    assert_eq!(edge_count, 0, "Edge should cascade delete");

    // Run integrity check
    let mut check_stmt = db.conn.prepare("PRAGMA foreign_key_check").unwrap();
    let mut check_rows = check_stmt.query([]).unwrap();
    assert!(
        check_rows.next().unwrap().is_none(),
        "Foreign key check should pass"
    );
}
