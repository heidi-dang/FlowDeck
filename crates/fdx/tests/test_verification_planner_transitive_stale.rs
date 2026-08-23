//! Tests for transitive stale test mapping relevance detection.

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
fn test_transitive_stale_mapping_edge_is_detected_and_widens_dependent_package() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    let core_dir = repo.join("packages/core");
    let app_dir = repo.join("packages/app");
    fs::create_dir_all(core_dir.join("src")).unwrap();
    fs::create_dir_all(app_dir.join("src")).unwrap();
    fs::create_dir_all(app_dir.join("tests")).unwrap();

    fs::write(core_dir.join("package.json"), r#"{ "name": "@my/core" }"#).unwrap();
    fs::write(app_dir.join("package.json"), r#"{ "name": "@my/app", "dependencies": { "@my/core": "workspace:*" }, "scripts": { "test": "vitest" } }"#).unwrap();

    fs::write(core_dir.join("src/index.ts"), "export const c = 1;").unwrap();
    fs::write(app_dir.join("src/app.ts"), "export const a = 1;").unwrap();
    fs::write(app_dir.join("tests/app.test.ts"), "test('app', () => {});").unwrap();
    fs::write(
        app_dir.join("tests/other.test.ts"),
        "test('other', () => {});",
    )
    .unwrap();

    // Persist stale edge targeting transitively impacted app file
    {
        let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/app/tests/app.test.ts', 'h1', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO files (canonical_path, content_hash, size, indexed_at) VALUES ('packages/app/src/app.ts', 'h2', 50, 100)",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/app/tests/app.test.ts', 'file', 'packages/app/tests/app.test.ts', 'pkg:npm:packages/app')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO nodes (stable_id, kind, canonical_path, package_identity) VALUES ('file:packages/app/src/app.ts', 'file', 'packages/app/src/app.ts', 'pkg:npm:packages/app')",
                [],
            )
            .unwrap();

        db.conn
            .execute(
                "INSERT INTO edges (stable_id, from_node, to_node, kind, provider, provider_fingerprint, strength, source_identity, source_hash, created_revision, updated_revision, stale, provider_id) VALUES ('edge:stale_app', 'file:packages/app/tests/app.test.ts', 'file:packages/app/src/app.ts', 'references', 'scip_ts', 'fp1', 4, 'packages/app/tests/app.test.ts', 'h1', 1, 1, 1, 'scip-typescript')",
                [],
            )
            .unwrap();
    }

    git_commit_all(repo, "initial");

    // Change core
    fs::write(core_dir.join("src/index.ts"), "export const c = 2;").unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // App stale mapping must be detected and widen app
    assert!(plan
        .uncertainty
        .iter()
        .any(|u| u.code().contains("stale") || u.code().contains("provider")));
    let has_app_other = plan
        .selected_checks
        .iter()
        .any(|c| c.check_id.contains("other.test.ts") || c.check_id.contains("test"));
    assert!(
        has_app_other,
        "App tests must be widened due to transitive stale mapping"
    );
}
