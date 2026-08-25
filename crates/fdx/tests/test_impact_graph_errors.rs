//! Milestone 4 graph failure semantics, edge safety, and ambiguity tests.

use fdx::intelligence::change::classify::classify_changes;
use fdx::intelligence::change::model::SemanticChangeKind;
use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphNode, IndexedFile};
use fdx::protocol::{AssuranceLevel, NodeKind};
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
fn test_duplicate_symbol_names_do_not_silently_collapse() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let ts_file = repo.join("classes.ts");
    fs::write(
        &ts_file,
        r#"
class A {
    run(): number { return 1; }
}

class B {
    run(): number { return 2; }
}
"#,
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Only modify B.run
    fs::write(
        &ts_file,
        r#"
class A {
    run(): number { return 1; }
}

class B {
    run(): number { return 999; }
}
"#,
    )
    .unwrap();

    let change_set = classify_changes(repo, Some("HEAD"), None).unwrap();

    // Verify A.run and B.run are not silently collapsed into one single overwritten entry
    let changes = change_set.changes;
    assert!(
        !changes.is_empty(),
        "Change classifier must detect modification in class B"
    );
    // Either qualified as B:run or explicitly scoped, but A.run must not be claimed as deleted/added
    assert!(
        !changes
            .iter()
            .any(|c| c.change_kind == SemanticChangeKind::SymbolDeleted
                && c.symbol.as_deref() == Some("run")),
        "A.run must not be reported deleted because of B.run"
    );
}

#[test]
fn test_absent_db_vs_corrupt_db_vs_future_schema() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("test.ts");
    fs::write(
        &file_a,
        "export const x = 1;
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    fs::write(
        &file_a,
        "export const x = 2;
",
    )
    .unwrap();

    // 1. Absent DB: should report ProviderMissing / GraphAbsent and fallback to unindexed
    let res_absent = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    assert!(
        res_absent
            .uncertainty
            .iter()
            .any(|u| u.code() == "provider_missing" || u.code() == "graph_absent"),
        "Absent DB must report provider_missing or graph_absent"
    );
    assert_eq!(res_absent.assurance, AssuranceLevel::Degraded);

    // 2. Corrupt DB: write junk into .fdx/index.sqlite
    let fdx_dir = repo.join(".fdx");
    fs::create_dir_all(&fdx_dir).unwrap();
    fs::write(fdx_dir.join("index.sqlite"), b"GARBAGE NON-SQLITE HEADER").unwrap();

    let res_corrupt = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    assert!(
        res_corrupt
            .uncertainty
            .iter()
            .any(|u| u.code() == "provider_failed" || u.code() == "graph_corrupt"),
        "Corrupt DB must report provider_failed or graph_corrupt"
    );
    assert_eq!(
        res_corrupt.assurance,
        AssuranceLevel::Unverified,
        "Corrupt DB must produce UNVERIFIED assurance"
    );

    // 3. Future schema DB: create sqlite with user_version = 999
    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    db.conn.pragma_update(None, "user_version", 999).unwrap();
    let _ = db
        .conn
        .execute("UPDATE schema_metadata SET version = 999", []);
    drop(db);

    let res_future = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();
    assert!(
        res_future
            .uncertainty
            .iter()
            .any(|u| u.code() == "provider_failed" || u.code() == "graph_incompatible"),
        "Future schema DB must report provider_failed or graph_incompatible"
    );
    assert_eq!(
        res_future.assurance,
        AssuranceLevel::Unverified,
        "Future schema DB must produce UNVERIFIED assurance"
    );
}

#[test]
fn test_unknown_edge_kind_fails_closed_and_not_treated_as_references() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("source.ts");
    let file_b = repo.join("other.ts");

    fs::write(
        &file_a,
        "export function testFn() {}
",
    )
    .unwrap();
    fs::write(
        &file_b,
        "export function otherFn() {}
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "source.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 100,
        content_hash: "h1".to_string(),
        mtime_ms: None,
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "other.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 100,
        content_hash: "h2".to_string(),
        mtime_ms: None,
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: "sym:source.ts:testFn".to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("source.ts".to_string()),
        symbol_identity: Some("testFn".to_string()),
        package_identity: None,
        metadata: Some(r#"{"display_name":"testFn"}"#.to_string()),
        source_identity: None,
    })
    .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: "file:other.ts".to_string(),
        kind: NodeKind::File,
        canonical_path: Some("other.ts".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
        source_identity: None,
    })
    .unwrap();

    // Insert unknown edge kind directly via SQL
    tx.tx.execute(
        "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, created_revision, updated_revision, stale)
         VALUES ('e:unk', 'file:other.ts', 'sym:source.ts:testFn', 'future_custom_relation_v99', 'test', 'fp', 4, 1, 1, 0)",
        [],
    ).unwrap();
    tx.commit().unwrap();

    // Change source.ts
    fs::write(
        &file_a,
        "export function testFn(): number { return 1; }
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Invariant: 'other.ts' must NOT be traversed as if 'future_custom_relation_v99' was References/Calls!
    let other_target = result.impacted.iter().find(|t| t.target == "other.ts");
    assert!(
        other_target.is_none(),
        "Unknown edge kind must NOT be treated as References"
    );
}
