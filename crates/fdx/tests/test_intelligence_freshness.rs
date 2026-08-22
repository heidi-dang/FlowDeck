use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::engine::run_incremental_index;
use fdx::intelligence::status::evaluate_index_status;
use fdx::protocol::GraphCompatibility;
use std::fs;
use tempfile::tempdir;

#[test]
fn test_freshness_snapshot_invalidation() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    // Create an empty git repo so the snapshot can have a HEAD
    std::process::Command::new("git")
        .arg("init")
        .current_dir(repo_root)
        .output()
        .unwrap();

    fs::write(repo_root.join("src1.ts"), "const a = 1;").unwrap();

    std::process::Command::new("git")
        .args(["add", "src1.ts"])
        .current_dir(repo_root)
        .output()
        .unwrap();

    std::process::Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(repo_root)
        .output()
        .unwrap();

    // First index -> should be fresh
    run_incremental_index(repo_root, false).unwrap();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let report1 = evaluate_index_status(repo_root, Ok(&db), &GraphCompatibility::default());
    println!("report1: {:?}", report1.reasons);
    println!("report1: {:?}", report1.reasons);
    println!("REASONS: {:?}", report1.reasons);
    assert_eq!(report1.state, "fresh");

    // Edit the file in the working tree
    fs::write(repo_root.join("src1.ts"), "const a = 2;").unwrap();

    // Now status should evaluate to STALE without re-indexing!
    let report2 = evaluate_index_status(repo_root, Ok(&db), &GraphCompatibility::default());
    assert_eq!(report2.state, "stale");
    assert!(report2
        .reasons
        .contains(&"working_tree_changed".to_string()));

    // Run index again -> should be fresh again
    run_incremental_index(repo_root, false).unwrap();
    let report3 = evaluate_index_status(repo_root, Ok(&db), &GraphCompatibility::default());
    assert_eq!(report3.state, "fresh");
}


#[test]
fn test_compatibility_invalidation() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();
    
    std::process::Command::new("git").arg("init").current_dir(repo_root).output().unwrap();
    std::process::Command::new("git").args(["config", "user.name", "test"]).current_dir(repo_root).output().unwrap();
    std::process::Command::new("git").args(["config", "user.email", "test@test.com"]).current_dir(repo_root).output().unwrap();
    fs::write(repo_root.join("src1.ts"), "const a = 1;").unwrap();
    std::process::Command::new("git").args(["add", "src1.ts"]).current_dir(repo_root).output().unwrap();
    std::process::Command::new("git").args(["commit", "-m", "init"]).current_dir(repo_root).output().unwrap();
    
    run_incremental_index(repo_root, false).unwrap();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    
    let current_compat = GraphCompatibility::default();
    
    let report1 = evaluate_index_status(repo_root, Ok(&db), &current_compat);
    assert_eq!(report1.state, "fresh");
    
    // Provider fingerprint changes -> should be STALE
    let mut bad_compat = current_compat.clone();
    bad_compat.provider_fingerprint = "different".to_string();
    let report2 = evaluate_index_status(repo_root, Ok(&db), &bad_compat);
    assert_eq!(report2.state, "stale");
    assert!(report2.reasons.contains(&"provider_refresh_required".to_string()));
    
    // Semantic model version changes -> should be STALE
    let mut bad_compat2 = current_compat.clone();
    bad_compat2.semantic_model_version = 999;
    let report3 = evaluate_index_status(repo_root, Ok(&db), &bad_compat2);
    assert_eq!(report3.state, "stale");
    assert!(report3.reasons.contains(&"semantic_rebuild_required".to_string()));
}
