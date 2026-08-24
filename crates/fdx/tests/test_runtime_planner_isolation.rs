use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::intelligence::verify::model::{VerificationOutcome, VerificationRun};
use fdx::protocol::AssuranceLevel;
use std::process::Command;
use tempfile::tempdir;

fn init_git_repo(path: &std::path::Path) {
    Command::new("git")
        .args(["init"])
        .current_dir(path)
        .output()
        .unwrap();
    Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(path)
        .output()
        .unwrap();
    Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(path)
        .output()
        .unwrap();
    Command::new("git")
        .args(["add", "."])
        .current_dir(path)
        .output()
        .unwrap();
    Command::new("git")
        .args(["commit", "-m", "initial commit", "--allow-empty"])
        .current_dir(path)
        .output()
        .unwrap();
}

#[test]
fn test_runtime_history_never_alters_planner_selected_checks() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{"name": "isolation-pkg", "packageManager": "npm@10.0.0", "scripts": {"test": "node -e 'process.exit(0)'"}}"#,
    )
    .unwrap();
    std::fs::write(dir.path().join("src.js"), "module.exports = 1;").unwrap();
    init_git_repo(dir.path());

    // Modify src.js to produce working-tree diff
    std::fs::write(dir.path().join("src.js"), "module.exports = 2;").unwrap();

    // Plan before any history exists
    let plan_before = plan_verification(dir.path(), None, None, None).unwrap();

    // Ingest 50 passing runs into M8 history
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();
    for i in 0..50 {
        let run = VerificationRun {
            run_id: format!("run_hist_{}", i),
            plan: plan_before.clone(),
            outcome: VerificationOutcome::Passed,
            assurance: AssuranceLevel::Exact,
            checks: vec![],
            uncertainty: vec![],
            base: None,
            head: None,
            persistence_status: fdx::intelligence::verify::model::PersistenceStatus::NotRequested,
            executed_at_ms: 1000 + i,
            duration_ms: 10,
        };
        let bytes = serde_json::to_vec(&run).unwrap();
        ingest_verification_artifact(&mut db.conn, &bytes).unwrap();
    }

    // Plan after history exists
    let plan_after = plan_verification(dir.path(), None, None, None).unwrap();

    assert_eq!(plan_before.selected_checks, plan_after.selected_checks);
    assert_eq!(plan_before.assurance, plan_after.assurance);
    assert_eq!(
        plan_before.unresolved_obligations,
        plan_after.unresolved_obligations
    );
}
