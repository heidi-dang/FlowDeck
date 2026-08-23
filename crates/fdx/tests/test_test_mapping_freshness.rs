//! Tests for test mapping freshness, stale old ∪ current mapping, deleted symbols, and provider failures.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::protocol::{AssuranceLevel, EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
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
fn test_deleted_symbol_preserves_test_mapping_via_old_current_union() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::create_dir_all(repo.join("tests")).unwrap();

    fs::write(
        repo.join("package.json"),
        r#"{ "name": "root-pkg", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("src/legacy.ts"),
        "export function legacyFn() { return 1; }
",
    )
    .unwrap();
    fs::write(
        repo.join("tests/legacy.test.ts"),
        "import { legacyFn } from '../src/legacy';
test('legacy', () => legacyFn());
",
    )
    .unwrap();

    git_commit_all(repo, "add legacy");

    // Index the legacy mapping in database
    {
        let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();

        let files = vec![
            IndexedFile {
                canonical_path: "src/legacy.ts".to_string(),
                content_hash: "hash1".to_string(),
                size: 40,
                mtime_ms: Some(100),
                language: Some("typescript".to_string()),
                indexed_at: 100,
            },
            IndexedFile {
                canonical_path: "tests/legacy.test.ts".to_string(),
                content_hash: "hash2".to_string(),
                size: 40,
                mtime_ms: Some(100),
                language: Some("typescript".to_string()),
                indexed_at: 100,
            },
        ];

        let nodes = vec![
            GraphNode {
                stable_id: "sym:src/legacy.ts:legacyFn".to_string(),
                kind: NodeKind::Symbol,
                canonical_path: Some("src/legacy.ts".to_string()),
                symbol_identity: Some("legacyFn".to_string()),
                package_identity: Some("pkg:npm:.".to_string()),
                metadata: None,
                source_identity: None,
            },
            GraphNode {
                stable_id: "file:tests/legacy.test.ts".to_string(),
                kind: NodeKind::File,
                canonical_path: Some("tests/legacy.test.ts".to_string()),
                symbol_identity: None,
                package_identity: Some("pkg:npm:.".to_string()),
                metadata: None,
                source_identity: None,
            },
        ];

        let edges = vec![GraphEdge {
            stable_id: "edge:legacy_test_refs_legacy_fn".to_string(),
            from_node: "file:tests/legacy.test.ts".to_string(),
            to_node: "sym:src/legacy.ts:legacyFn".to_string(),
            kind: EdgeKind::References,
            provider: EvidenceProviderKind::Scip,
            provider_id: Some("builtin-scip-ts".to_string()),
            provider_fingerprint: "builtin-scip-ts".to_string(),
            strength: EvidenceStrength::Precise,
            source_identity: None,
            source_hash: None,
            created_revision: 1,
            updated_revision: 1,
            stale: false,
        }];

        let tx = TransactionalGraph::new(&mut db.conn).unwrap();
        for f in &files {
            tx.insert_file(f).unwrap();
        }
        for n in &nodes {
            tx.insert_node(n).unwrap();
        }
        for e in &edges {
            tx.insert_edge(e).unwrap();
        }
        tx.commit().unwrap();
    }

    // Now delete legacyFn from src/legacy.ts
    fs::write(
        repo.join("src/legacy.ts"),
        "// legacyFn removed
",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Must still select tests/legacy.test.ts because before-evidence shows it referenced legacyFn
    let selected = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.ends_with("tests/legacy.test.ts"));
    assert!(
        selected.is_some(),
        "tests/legacy.test.ts must be selected when legacyFn is deleted"
    );
}

#[test]
fn test_stale_scip_widens_to_package_test_target() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/mod/src")).unwrap();
    fs::create_dir_all(repo.join("packages/mod/tests")).unwrap();

    fs::write(
        repo.join("packages/mod/package.json"),
        r#"{ "name": "@my/mod", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(repo.join("packages/mod/src/a.ts"), "export const a = 1;").unwrap();
    fs::write(
        repo.join("packages/mod/tests/a.test.ts"),
        "test('a', () => {});",
    )
    .unwrap();
    fs::write(
        repo.join("packages/mod/tests/b.test.ts"),
        "test('b', () => {});",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    // Modify a.ts
    fs::write(repo.join("packages/mod/src/a.ts"), "export const a = 2;").unwrap();

    // No SCIP index exists or SCIP is stale -> planner must fail closed and widen to package tests/targets
    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    assert!(
        plan.assurance <= AssuranceLevel::Conservative,
        "Assurance should be <= Conservative without fresh precise SCIP"
    );
    // Package test target or all tests in package should be selected conservatively
    let has_package_test = plan
        .selected_checks
        .iter()
        .any(|c| c.scope.contains("packages/mod") || c.check_id.contains("packages/mod"));
    assert!(
        has_package_test,
        "Should select package test checks conservatively"
    );
}
