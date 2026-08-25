//! Milestone 4 stale edge and fallback widening tests.

use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::index::TransactionalGraph;
use fdx::intelligence::model::{GraphEdge, GraphNode, IndexedFile};
use fdx::intelligence::semantic::health::{ProviderFreshness, ProviderHealth};
use fdx::intelligence::semantic::provider::{
    now_ms, ProviderFingerprint, ProviderIdentity, ProviderScope, ProviderState, ProviderType,
};
use fdx::intelligence::semantic::state::upsert_provider_state;
use fdx::intelligence::semantic::LanguageId;
use fdx::protocol::{AssuranceLevel, EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
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
fn test_stale_scip_edge_does_not_suppress_fallback_widening_for_new_consumer() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("src/a.ts");
    let file_b = repo.join("src/old_consumer.ts");
    let file_c = repo.join("src/new_consumer.ts");
    let tsconfig = repo.join("tsconfig.json");

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        &file_a,
        "export function coreFn(): number { return 1; }
",
    )
    .unwrap();
    fs::write(
        &file_b,
        "import { coreFn } from './a';
export function oldUse() { return coreFn(); }
",
    )
    .unwrap();
    fs::write(&tsconfig, r#"{"compilerOptions":{"strict":true}}"#).unwrap();
    git_commit_all(repo, "commit_1");

    let mock_bin = repo.join("mock-scip-ts");
    fs::write(&mock_bin, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&mock_bin, fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::env::set_var("SCIP_TYPESCRIPT_BIN", &mock_bin);
    let _exec_digest =
        fdx::intelligence::semantic::provider::executable_content_digest(&mock_bin).unwrap();

    let canonical_scip_id = "sem:scip-typescript npm @demo/pkg 1.0.0 src/a.ts/coreFn().";
    let config_fp = fdx::intelligence::semantic::provider::fingerprint_config_files(
        repo,
        &[Path::new("tsconfig.json")],
    )
    .unwrap();

    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let tx = TransactionalGraph::new(&mut db.conn).unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/a.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 100,
        content_hash: "h1".to_string(),
        mtime_ms: None,
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_file(&IndexedFile {
        canonical_path: "src/old_consumer.ts".to_string(),
        language: Some("typescript".to_string()),
        size: 100,
        content_hash: "h2".to_string(),
        mtime_ms: None,
        indexed_at: 1,
    })
    .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: canonical_scip_id.to_string(),
        kind: NodeKind::Symbol,
        canonical_path: Some("src/a.ts".to_string()),
        symbol_identity: Some("coreFn".to_string()),
        package_identity: Some("pkg:npm/@demo/pkg@1.0.0".to_string()),
        metadata: Some(r#"{"display_name":"coreFn","scip_kind":17}"#.to_string()),
        source_identity: None,
    })
    .unwrap();
    tx.insert_node(&GraphNode {
        stable_id: "file:src/old_consumer.ts".to_string(),
        kind: NodeKind::File,
        canonical_path: Some("src/old_consumer.ts".to_string()),
        symbol_identity: None,
        package_identity: None,
        metadata: None,
        source_identity: None,
    })
    .unwrap();

    // Stale SCIP edge points only to old_consumer.ts
    tx.insert_edge(&GraphEdge {
        stable_id: "e_old".to_string(),
        from_node: "file:src/old_consumer.ts".to_string(),
        to_node: canonical_scip_id.to_string(),
        kind: EdgeKind::References,
        provider: EvidenceProviderKind::Scip,
        provider_id: Some("scip-typescript".to_string()),
        provider_fingerprint: "stale-fp".to_string(),
        strength: EvidenceStrength::Precise,
        source_identity: None,
        source_hash: None,
        created_revision: 1,
        updated_revision: 1,
        stale: false,
    })
    .unwrap();

    let state = ProviderState {
        identity: ProviderIdentity {
            provider_id: "scip-typescript".to_string(),
            provider_type: ProviderType::Scip,
            provider_version: "0.4.0".to_string(),
            executable_identity: "mock-exec".to_string(),
            scip_schema_version: "0.1.0".to_string(),
        },
        scope: ProviderScope {
            workspace_root: String::new(),
            package: None,
            languages: vec![LanguageId::TypeScript],
        },
        fingerprint: ProviderFingerprint {
            config_fingerprint: config_fp,
            digest: "different-current-fp".to_string(),
            compiler_version: None,
            executable_identity: "mock-exec".to_string(),
            provider_version: "0.4.0".to_string(),
            scip_schema_version: "0.1.0".to_string(),
        },
        last_successful_run: Some(now_ms()),
        health: ProviderHealth::Available,
        freshness: ProviderFreshness::Stale, // Effectively Stale!
        output_digest: Some("out-dig".to_string()),
        failure_reason: None,
        semantic_generation: 1,
        last_attempt_fingerprint: None,
        last_attempt_at: None,
        last_attempt_health: None,
        last_attempt_failure_reason: None,
    };
    upsert_provider_state(&tx, &state).unwrap();
    tx.commit().unwrap();

    // Now introduce new_consumer.ts in working tree that imports coreFn from a.ts!
    fs::write(
        &file_c,
        "import { coreFn } from './a';
export function newUse() { return coreFn() + 2; }
",
    )
    .unwrap();
    // And modify a.ts
    fs::write(
        &file_a,
        "export function coreFn(): number { return 99; }
",
    )
    .unwrap();

    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Invariant: Both old_consumer.ts (from historical/stale edge) AND new_consumer.ts (from fallback widening)
    // MUST be included in impacted targets!
    let old_target = result
        .impacted
        .iter()
        .find(|t| t.target == "src/old_consumer.ts");
    let new_target = result
        .impacted
        .iter()
        .find(|t| t.target == "src/new_consumer.ts");

    assert!(
        old_target.is_some(),
        "Old consumer from stale edge must be included"
    );
    assert!(
        new_target.is_some(),
        "New consumer discoverable via fallback must be included (stale edge must NOT suppress widening!)"
    );
    assert!(
        result
            .uncertainty
            .iter()
            .any(|u| u.code() == "provider_stale"),
        "ProviderStale uncertainty must be present"
    );
    assert_ne!(
        result.assurance,
        AssuranceLevel::Exact,
        "Stale provider edge must prevent EXACT assurance"
    );

    std::env::remove_var("SCIP_TYPESCRIPT_BIN");
}
