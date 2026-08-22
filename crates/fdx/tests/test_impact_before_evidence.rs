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

#[test]
fn test_deleted_side_effect_import() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let app_ts = repo.join("app.ts");
    let polyfill_ts = repo.join("polyfill.ts");

    fs::write(&app_ts, "import \"./polyfill\";\n").unwrap();
    fs::write(&polyfill_ts, "globalThis.__ready = true;\n").unwrap();
    git_commit_all(repo, "commit_1_add_files");

    // Commit B: delete polyfill.ts
    fs::remove_file(&polyfill_ts).unwrap();
    git_commit_all(repo, "commit_2_delete_polyfill");

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "app.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 50,
        content_hash: "h2".to_string(),
        mtime_ms: None,
        indexed_at: 2,
    })
    .unwrap();
    tx.commit().unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD~1"), None, Some(3)).unwrap();

    let app_target = result.impacted.iter().find(|t| t.target == "app.ts");
    assert!(
        app_target.is_some(),
        "app.ts must be impacted when its side-effect import is deleted"
    );
}

#[test]
fn test_deleted_index_import() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let app_ts = repo.join("app.ts");
    let pkg_dir = repo.join("pkg");
    fs::create_dir(&pkg_dir).unwrap();
    let index_ts = pkg_dir.join("index.ts");

    fs::write(&app_ts, "import \"./pkg\";\n").unwrap();
    fs::write(&index_ts, "export const x = 1;\n").unwrap();
    git_commit_all(repo, "commit_1_add_files");

    // Commit B: delete pkg/index.ts
    fs::remove_file(&index_ts).unwrap();
    git_commit_all(repo, "commit_2_delete_index");

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "app.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 50,
        content_hash: "h2".to_string(),
        mtime_ms: None,
        indexed_at: 2,
    })
    .unwrap();
    tx.commit().unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD~1"), None, Some(3)).unwrap();

    let app_target = result.impacted.iter().find(|t| t.target == "app.ts");
    assert!(
        app_target.is_some(),
        "app.ts must be impacted when its index import is deleted"
    );
}

#[test]
fn test_current_base_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let app_ts = repo.join("app.ts");
    let old_ts = repo.join("old.ts");
    let new_ts = repo.join("new.ts");

    fs::write(&app_ts, "import \"./old\";\n").unwrap();
    fs::write(&old_ts, "export const o = 1;\n").unwrap();
    git_commit_all(repo, "commit_1");

    // Replace old with new
    fs::remove_file(&old_ts).unwrap();
    fs::write(&app_ts, "import \"./new\";\n").unwrap();
    fs::write(&new_ts, "export const n = 1;\n").unwrap();
    git_commit_all(repo, "commit_2");

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "app.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 50,
        content_hash: "h2".to_string(),
        mtime_ms: None,
        indexed_at: 2,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "new.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 50,
        content_hash: "h2".to_string(),
        mtime_ms: None,
        indexed_at: 2,
    })
    .unwrap();
    tx.commit().unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD~1"), None, Some(3)).unwrap();

    // Impact should find that old.ts was deleted, meaning old.ts is in changes.
    // The change to app.ts should not mix up old and new.
    // Ensure "new.ts" is not considered impacted just because it exists, unless through app.ts
    // Wait, the test checks if import resolution uses the right file universe.
    // If current used base universe, "import ./new" in app.ts (current) would fail to resolve because new.ts isn't in base.
    // If base used current universe, "import ./old" in app.ts (base) would fail to resolve because old.ts isn't in current.

    // We can verify that old.ts is present in the fallback index of base_ref by ensuring app.ts is impacted by old.ts deletion.
    let app_target = result
        .impacted
        .iter()
        .find(|t| t.target == "app.ts")
        .unwrap();
    let ev_path = app_target.primary_path.as_ref().unwrap();

    // old.ts is deleted. Seed is old.ts
    assert!(
        ev_path.explanation.contains("old.ts")
            || ev_path.seed_node.contains("old.ts")
            || result.impacted.iter().any(|t| t.target == "old.ts")
    );
}
