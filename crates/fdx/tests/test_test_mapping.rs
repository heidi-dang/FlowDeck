//! Tests for test-to-code mapping (precise, structural, and build-transitive).

use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::protocol::{EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
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
fn test_precise_scip_test_mapping() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("packages/api/src")).unwrap();
    fs::create_dir_all(repo.join("packages/api/tests")).unwrap();

    fs::write(
        repo.join("packages/api/package.json"),
        r#"{ "name": "@my/api", "scripts": { "test": "vitest" } }"#,
    )
    .unwrap();
    fs::write(
        repo.join("packages/api/src/user.ts"),
        "export function createUser() { return 1; }
export function deleteUser() { return 2; }
",
    )
    .unwrap();
    fs::write(
        repo.join("packages/api/tests/user.test.ts"),
        "import { createUser } from '../src/user';
test('createUser', () => createUser());
",
    )
    .unwrap();
    fs::write(
        repo.join("packages/api/tests/other.test.ts"),
        "test('other', () => {});
",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    let mock_bin = repo.join("mock-scip-ts");
    fs::write(&mock_bin, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&mock_bin, fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);

    git_commit_all(repo, "add mock scip");

    fdx::intelligence::build::ingest::refresh_all_build_providers(repo, false).unwrap();

    use fdx::intelligence::semantic::provider::SemanticProvider;
    let ts_provider = fdx::intelligence::semantic::scip::ts::ScipTypescriptProvider::new();
    let fp = ts_provider
        .passive_fingerprint(repo, Some("0.4.0"))
        .unwrap();

    let exec_digest =
        fdx::intelligence::semantic::provider::executable_content_digest(&mock_bin).unwrap();

    // Persist SCIP evidence in DB: user.test.ts REFERENCES createUser
    {
        let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();

        let files = vec![
            IndexedFile {
                canonical_path: "packages/api/src/user.ts".to_string(),
                content_hash: "hash1".to_string(),
                size: 50,
                mtime_ms: None,
                language: Some("typescript".to_string()),
                indexed_at: 100,
            },
            IndexedFile {
                canonical_path: "packages/api/tests/user.test.ts".to_string(),
                content_hash: "hash2".to_string(),
                size: 50,
                mtime_ms: None,
                language: Some("typescript".to_string()),
                indexed_at: 100,
            },
        ];

        let nodes = vec![
            GraphNode {
                stable_id: "sym:packages/api/src/user.ts:createUser".to_string(),
                kind: NodeKind::Symbol,
                canonical_path: Some("packages/api/src/user.ts".to_string()),
                symbol_identity: Some("createUser".to_string()),
                package_identity: Some("pkg:npm:packages/api".to_string()),
                metadata: Some(r#"{"display_name":"createUser"}"#.to_string()),
                source_identity: None,
            },
            GraphNode {
                stable_id: "file:packages/api/tests/user.test.ts".to_string(),
                kind: NodeKind::File,
                canonical_path: Some("packages/api/tests/user.test.ts".to_string()),
                symbol_identity: None,
                package_identity: Some("pkg:npm:packages/api".to_string()),
                metadata: None,
                source_identity: None,
            },
        ];

        let edges = vec![GraphEdge {
            stable_id: "edge:user_test_refs_create_user".to_string(),
            from_node: "file:packages/api/tests/user.test.ts".to_string(),
            to_node: "sym:packages/api/src/user.ts:createUser".to_string(),
            kind: EdgeKind::References,
            provider: EvidenceProviderKind::Scip,
            provider_id: Some("scip-typescript".to_string()),
            provider_fingerprint: fp.digest.clone(),
            strength: EvidenceStrength::Precise,
            source_identity: None,
            source_hash: None,
            created_revision: 1,
            updated_revision: 1,
            stale: false,
        }];

        let state = fdx::intelligence::semantic::provider::ProviderState {
            identity: fdx::intelligence::semantic::provider::ProviderIdentity {
                provider_id: "scip-typescript".to_string(),
                provider_type: fdx::intelligence::semantic::provider::ProviderType::Scip,
                provider_version: "0.4.0".to_string(),
                executable_identity: exec_digest,
                scip_schema_version: "0.1.0".to_string(),
            },
            scope: fdx::intelligence::semantic::provider::ProviderScope {
                workspace_root: String::new(),
                package: None,
                languages: vec![fdx::intelligence::semantic::LanguageId::TypeScript],
            },
            fingerprint: fp.clone(),
            last_successful_run: Some(1000),
            health: fdx::intelligence::semantic::health::ProviderHealth::Available,
            freshness: fdx::intelligence::semantic::health::ProviderFreshness::Fresh,
            output_digest: Some(fp.digest),
            failure_reason: None,
            semantic_generation: 1,
            last_attempt_fingerprint: None,
            last_attempt_at: None,
            last_attempt_health: None,
            last_attempt_failure_reason: None,
        };

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
        fdx::intelligence::semantic::state::upsert_provider_state(&tx, &state).unwrap();
        tx.commit().unwrap();
    }

    // Now modify createUser in packages/api/src/user.ts
    fs::write(
        repo.join("packages/api/src/user.ts"),
        "export function createUser() { return 42; }
export function deleteUser() { return 2; }
",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // Assert: user.test.ts is selected via precise semantic evidence
    let selected_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.ends_with("packages/api/tests/user.test.ts"));
    assert!(selected_test.is_some(), "user.test.ts should be selected");
    assert_eq!(selected_test.unwrap().strength, EvidenceStrength::Precise);

    // Assert: other.test.ts is NOT selected because it is unrelated and evidence is fresh & precise
    let other_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.ends_with("packages/api/tests/other.test.ts"));
    assert!(other_test.is_none(), "other.test.ts should not be selected");
}

#[test]
fn test_build_transitive_test_mapping() {
    let tmp = tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    // pkg A depends on pkg B
    fs::create_dir_all(repo.join("packages/core/src")).unwrap();
    fs::create_dir_all(repo.join("packages/app/src")).unwrap();
    fs::create_dir_all(repo.join("packages/app/tests")).unwrap();

    fs::write(
        repo.join("packages/core/package.json"),
        r#"{ "name": "@my/core", "version": "1.0.0" }"#,
    )
    .unwrap();
    fs::write(
        repo.join("packages/core/src/index.ts"),
        "export const VERSION = '1.0';",
    )
    .unwrap();

    fs::write(
        repo.join("packages/app/package.json"),
        r#"{
          "name": "@my/app",
          "version": "1.0.0",
          "dependencies": { "@my/core": "workspace:*" },
          "scripts": { "test": "vitest" }
        }"#,
    )
    .unwrap();
    fs::write(
        repo.join("packages/app/src/main.ts"),
        "import { VERSION } from '@my/core';
export const app = VERSION;
",
    )
    .unwrap();
    fs::write(
        repo.join("packages/app/tests/main.test.ts"),
        "import { app } from '../src/main';
test('app', () => app);
",
    )
    .unwrap();

    git_commit_all(repo, "initial");

    // Modify packages/core/src/index.ts
    fs::write(
        repo.join("packages/core/src/index.ts"),
        "export const VERSION = '2.0';",
    )
    .unwrap();

    let plan = plan_verification(repo, Some("HEAD"), None, None).expect("plan verification");

    // App's test must be selected because core is changed and app depends on core
    let app_test = plan
        .selected_checks
        .iter()
        .find(|c| c.check_id.contains("packages/app"));
    assert!(
        app_test.is_some(),
        "app test or target should be selected due to build dependency on core"
    );
}
