//! Milestone 4 before-state evidence and deletion impact tests.

use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphNode, IndexedFile};
use fdx::protocol::NodeKind;
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
fn test_deleted_symbol_after_current_reindex_still_includes_consumer() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("math.ts");
    let file_b = repo.join("app.ts");

    fs::write(
        &file_a,
        "export function helper() { return 1; }
",
    )
    .unwrap();
    fs::write(
        &file_b,
        "import { helper } from './math';
export function run() { return helper(); }
",
    )
    .unwrap();
    git_commit_all(repo, "commit_1_define_helper");

    // Reindex at commit 2: delete helper from math.ts
    fs::write(
        &file_a,
        "// helper deleted
export const unused = 0;
",
    )
    .unwrap();
    git_commit_all(repo, "commit_2_delete_helper");

    // Current DB only indexes commit 2 (so node for helper is NOT in current DB!)
    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "math.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 50,
        content_hash: "h2".to_string(),
        mtime_ms: None,
        indexed_at: 2,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "app.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 80,
        content_hash: "h3".to_string(),
        mtime_ms: None,
        indexed_at: 2,
    })
    .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: "sym:math.ts:unused".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("math.ts".to_string()),
        symbol_identity: Some("unused".to_string()),
        package_identity: None,
        metadata: Some(r#"{"display_name":"unused"}"#.to_string()),
        source_identity: None,
    })
    .unwrap();
    tx.commit().unwrap();

    // Now analyze impact comparing commit 2 against commit 1 (base_ref: "HEAD~1")
    let result = analyze_impact_v2(repo, Some("HEAD~1"), None, Some(3)).unwrap();

    // Invariant: app.ts imported helper in before-state, so app.ts MUST be included in impact!
    let app_target = result.impacted.iter().find(|t| t.target == "app.ts");
    assert!(
        app_target.is_some(),
        "Consumer app.ts must be included when symbol was deleted, even if current DB lacks old symbol"
    );
}
