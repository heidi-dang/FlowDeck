//! Tests for relevant vs disconnected stale TestMappingEdge evidence handling and assurance.

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::testplan::model::SelectionReason;
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
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
fn test_relevant_stale_mapping_forces_package_widening_and_non_exact_assurance() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/stale-pkg");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/stale-pkg", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 1; }",
    )
    .unwrap();
    fs::write(pkg_dir.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(
        pkg_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Persist stale edge (stale = 1)
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/stale-pkg/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/stale-pkg/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/stale-pkg/tests/a.test.ts', 'file', 'packages/stale-pkg/tests/a.test.ts', 'pkg:npm:packages/stale-pkg')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/stale-pkg/src/a.ts', 'file', 'packages/stale-pkg/src/a.ts', 'pkg:npm:packages/stale-pkg')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/stale-pkg/src/a.ts:fnA', 'symbol', 'packages/stale-pkg/src/a.ts', 'fnA', 'pkg:npm:packages/stale-pkg')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:stale_a', 'file:packages/stale-pkg/tests/a.test.ts', 'sym:packages/stale-pkg/src/a.ts:fnA', 'references', 'scip_ts', 'fp1', 4, 'packages/stale-pkg/tests/a.test.ts', 'h1', 1, 1, 1, 'scip-typescript')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");
    fs::write(
        pkg_dir.join("src/a.ts"),
        "export function fnA() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Stale edge must be present in selected checks with stale = true in evidence_refs
    let a_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("a.test.ts"))
        .expect("a.test.ts selected");

    assert_eq!(a_test.selection, SelectionReason::Evidence);
    assert_eq!(a_test.strength, EvidenceStrength::Precise);
    assert!(!a_test.evidence_refs.is_empty());
    assert!(
        a_test.evidence_refs[0].stale,
        "stale flag must be preserved"
    );

    // Package widening must also select other tests in the package
    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("other.test.ts"));
    assert!(
        other_test.is_some(),
        "conservative package widening must select other.test.ts"
    );

    // Assurance must not be Exact
    assert_ne!(plan.assurance, AssuranceLevel::Exact);
}

#[test]
fn test_disconnected_stale_mapping_does_not_affect_unrelated_package() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pa = repo.join("packages/pa");
    let pb = repo.join("packages/pb");
    fs::create_dir_all(pa.join("src")).unwrap();
    fs::create_dir_all(pa.join("tests")).unwrap();
    fs::create_dir_all(pb.join("src")).unwrap();
    fs::create_dir_all(pb.join("tests")).unwrap();

    fs::write(
        pa.join("package.json"),
        r#"{ "name": "@my/pa", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        pb.join("package.json"),
        r#"{ "name": "@my/pb", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();

    fs::write(pa.join("src/a.ts"), "export function fnA() { return 1; }").unwrap();
    fs::write(pa.join("tests/a.test.ts"), "test('a', () => {});").unwrap();
    fs::write(pb.join("src/b.ts"), "export function fnB() { return 1; }").unwrap();
    fs::write(pb.join("tests/b.test.ts"), "test('b', () => {});").unwrap();

    // Persist stale edge ONLY in disconnected package A
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/tests/a.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/pa/src/a.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pa/tests/a.test.ts', 'file', 'packages/pa/tests/a.test.ts', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/pa/src/a.ts', 'file', 'packages/pa/src/a.ts', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/pa/src/a.ts:fnA', 'symbol', 'packages/pa/src/a.ts', 'fnA', 'pkg:npm:packages/pa')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:stale_a', 'file:packages/pa/tests/a.test.ts', 'sym:packages/pa/src/a.ts:fnA', 'references', 'scip_ts', 'fp1', 4, 'packages/pa/tests/a.test.ts', 'h1', 1, 1, 1, 'scip-typescript')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Only modify package B
    fs::write(pb.join("src/b.ts"), "export function fnB() { return 2; }").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Package A checks must NOT be selected
    let has_a = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("packages/pa"));
    assert!(!has_a, "Disconnected package A must not be selected");

    // Package B check must be selected
    let has_b = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("packages/pb"));
    assert!(has_b, "Changed package B must be selected");
}
