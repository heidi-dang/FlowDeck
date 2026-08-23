//! Tests for complete mapping provenance, evidence paths, and explainability contracts.

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
fn test_every_selected_check_satisfies_explainability_contract() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let pkg_dir = repo.join("packages/api");
    fs::create_dir_all(pkg_dir.join("src")).unwrap();
    fs::create_dir_all(pkg_dir.join("tests")).unwrap();

    fs::write(
        pkg_dir.join("package.json"),
        r#"{ "name": "@my/api", "scripts": { "test": "vitest", "typecheck": "tsc" } }"#,
    )
    .unwrap();

    fs::write(
        pkg_dir.join("src/user.ts"),
        "export function getUser() { return 1; }",
    )
    .unwrap();
    fs::write(
        pkg_dir.join("tests/user.test.ts"),
        "test('user', () => {});",
    )
    .unwrap();

    // Persist exact SCIP edge in DB
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/tests/user.test.ts', 'hash1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/api/src/user.ts', 'hash2', 50, 100)",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/api/tests/user.test.ts', 'file', 'packages/api/tests/user.test.ts', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, symbol_identity, package_identity) VALUES ('sym:packages/api/src/user.ts:getUser', 'symbol', 'packages/api/src/user.ts', 'getUser', 'pkg:npm:packages/api')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                r#"INSERT INTO semantic_providers (provider_id, provider_type, provider_version, executable_identity, scip_schema_version, languages, workspace_root, package, config_fingerprint, input_fingerprint, health, freshness, semantic_generation, created_at, updated_at)
                   VALUES ('scip-typescript', 'scip', '1.0', 'scip-ts', '0.1', '["typescript"]', '.', 'packages/api', 'cfg_api', 'fp123', 'available', 'fresh', 1, 100, 100)"#,
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:user_test_refs_getUser', 'file:packages/api/tests/user.test.ts', 'sym:packages/api/src/user.ts:getUser', 'references', 'scip_ts', 'fp123', 4, 'packages/api/tests/user.test.ts', 'hash1', 1, 1, 0, 'scip-typescript')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    fs::write(
        pkg_dir.join("src/user.ts"),
        "export function getUser() { return 2; }",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    assert!(!plan.selected_checks.is_empty());

    for check in &plan.selected_checks {
        match check.selection {
            SelectionReason::Evidence => {
                assert!(
                    check.evidence_path.is_some(),
                    "Check {} with SelectionReason::Evidence must have an evidence_path",
                    check.check_id
                );
                let path = check.evidence_path.as_ref().unwrap();
                assert!(!path.steps.is_empty() || !path.explanation.is_empty());

                assert!(
                    !check.evidence_refs.is_empty(),
                    "Check {} with SelectionReason::Evidence must have evidence_refs",
                    check.check_id
                );
                let ev = &check.evidence_refs[0];
                assert_eq!(ev.provider_id, "scip-typescript");
                assert_eq!(ev.provider_fingerprint.as_deref(), Some("fp123"));
                assert_eq!(
                    ev.evidence_id.as_deref(),
                    Some("edge:user_test_refs_getUser")
                );
                assert_eq!(ev.strength, EvidenceStrength::Precise);
                assert!(!ev.stale);
            }
            SelectionReason::PolicyWidening => {
                assert!(
                    check.widening_reason.is_some(),
                    "Check {} with SelectionReason::PolicyWidening must have a widening_reason",
                    check.check_id
                );
            }
            SelectionReason::MandatoryCheck => {
                assert!(
                    !check.reason.is_empty(),
                    "Check {} with SelectionReason::MandatoryCheck must have a reason",
                    check.check_id
                );
                assert!(check.mandatory);
            }
        }
    }
}
