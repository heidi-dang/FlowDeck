//! Tests for evidence provenance retention (provider_id, fingerprint, evidence_id, source_identity, strength, stale).

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::testplan::model::SelectionReason;
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::protocol::EvidenceStrength;
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
fn test_persisted_scip_edge_provenance_preserved_in_planned_check() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/prov");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/prov", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(
        pkg_dir.join("src/calc.ts"),
        "export function add(a: number, b: number) { return a + b; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/calc.test.ts"), "test('add', () => {});").unwrap();

    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/prov/tests/calc.test.ts', 'hash_test', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/prov/src/calc.ts', 'hash_src', 50, 100)",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/prov/tests/calc.test.ts', 'file', 'packages/prov/tests/calc.test.ts', 'pkg:npm:packages/prov')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/prov/src/calc.ts:add', 'symbol', 'packages/prov/src/calc.ts', 'add', 'pkg:npm:packages/prov')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:calc_test_to_add', 'file:packages/prov/tests/calc.test.ts', 'sym:packages/prov/src/calc.ts:add', 'references', 'scip_ts', 'fp_calc_99', 4, 'packages/prov/tests/calc.test.ts', 'hash_test', 1, 1, 0, 'scip-typescript')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");
    fs::write(
        pkg_dir.join("src/calc.ts"),
        "export function add(a: number, b: number) { return a + b + 1; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    let test_check = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("calc.test.ts"))
        .expect("calc.test.ts selected");

    assert_eq!(test_check.selection, SelectionReason::Evidence);
    assert_eq!(test_check.strength, EvidenceStrength::Precise);
    assert!(!test_check.evidence_refs.is_empty());

    let ref_item = &test_check.evidence_refs[0];
    assert_eq!(
        ref_item.evidence_id.as_deref(),
        Some("edge:calc_test_to_add")
    );
    assert_eq!(ref_item.provider_id, "scip-typescript");
    assert_eq!(ref_item.provider_fingerprint.as_deref(), Some("fp_calc_99"));
    assert_eq!(ref_item.strength, EvidenceStrength::Precise);
    assert!(!ref_item.stale);
}
