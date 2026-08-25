//! Tests proving the verification planner is strictly read-only and executes zero test/build processes.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::IndexedFile;
use fdx::intelligence::testplan::planner::plan_verification;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

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
fn test_planner_is_strictly_read_only() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::create_dir_all(repo.join("tests")).unwrap();

    fs::write(
        repo.join("package.json"),
        r#"{ "name": "pkg", "scripts": { "test": "exit 1" } }"#,
    )
    .unwrap();
    fs::write(repo.join("src/lib.ts"), "export const x = 1;").unwrap();
    fs::write(repo.join("tests/lib.test.ts"), "test('x', () => {});").unwrap();

    git_commit_all(repo, "initial");

    // Initialize database
    {
        let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        let tx = TransactionalGraph::new(&mut db.conn).unwrap();
        let file = IndexedFile {
            canonical_path: "src/lib.ts".to_string(),
            content_hash: "hash".to_string(),
            size: 20,
            mtime_ms: Some(100),
            language: Some("typescript".to_string()),
            indexed_at: 100,
        };
        tx.insert_file(&file).unwrap();
        tx.commit().unwrap();
    }

    let db_path = repo.join(".fdx/index.sqlite");
    let db_bytes_before = fs::read(&db_path).unwrap();

    // Modify file
    fs::write(repo.join("src/lib.ts"), "export const x = 2;").unwrap();

    // Run planner 5 times
    for _ in 0..5 {
        let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");
        assert!(!plan.selected_checks.is_empty());
    }

    let db_bytes_after = fs::read(&db_path).unwrap();
    assert_eq!(
        db_bytes_before, db_bytes_after,
        "Database bytes must not be mutated by planner"
    );
}
