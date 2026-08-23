//! Tests ensuring ordinary source files are never treated as test identities.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
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
fn test_ordinary_source_file_never_becomes_test_check() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/api");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/api", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(pkg_dir.join("src/a.ts"), "export const a = 1;").unwrap();
    fs::write(
        pkg_dir.join("src/b.ts"),
        "import { a } from './a'; export const b = a;",
    )
    .unwrap();
    fs::write(
        pkg_dir.join("tests/unrelated.test.ts"),
        "test('u', () => {});",
    )
    .unwrap();

    // Persist edge: file:packages/api/src/b.ts REFERENCES sym:...
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/a.ts', 'hash1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/b.ts', 'hash2', 50, 100)",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/api/src/a.ts:a', 'symbol', 'packages/api/src/a.ts', 'a', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/api/src/b.ts', 'file', 'packages/api/src/b.ts', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('src_edge_1', 'file:packages/api/src/b.ts', 'sym:packages/api/src/a.ts:a', 'references', 'scip_ts', 'fp1', 4, 'packages/api/src/b.ts', 'hash1', 1, 1, 0, 'scip-typescript')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(pkg_dir.join("src/a.ts"), "export const a = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Planner must NOT invent test:npm:packages/api/src/b.ts
    let has_b_as_test = plan.selected_checks.iter().any(|c| {
        c.check_id.contains("src/b.ts") || c.check_id.starts_with("test:npm:packages/api/src/b.ts")
    });

    assert!(
        !has_b_as_test,
        "Ordinary source file src/b.ts must never be selected as a test check"
    );
}
