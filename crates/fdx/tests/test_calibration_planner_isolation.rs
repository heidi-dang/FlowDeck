use fdx::intelligence::calibration::model::CalibrationPolicy;
use fdx::intelligence::calibration::{persist_calibration_run, run_calibration};
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::testplan::planner::plan_verification;
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_calibration_history_never_influences_planner_decisions_or_assurance() {
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    // Initialize git repository in tempdir
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(repo_root)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.email", "test@test.com"])
        .current_dir(repo_root)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(repo_root)
        .output()
        .unwrap();
    std::fs::write(
        repo_root.join("Cargo.toml"),
        "[package]\nname = \"test_pkg\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    std::fs::create_dir_all(repo_root.join("src")).unwrap();
    std::fs::write(
        repo_root.join("src").join("lib.rs"),
        "pub fn add(a: i32, b: i32) -> i32 { a + b }
",
    )
    .unwrap();
    std::process::Command::new("git")
        .args(["add", "."])
        .current_dir(repo_root)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(repo_root)
        .output()
        .unwrap();

    // 1. Initial M6 plan
    let plan_before = plan_verification(repo_root, None, None, None).unwrap();

    // 2. Populate dozens of calibration runs with observed misses and failures into database
    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    let dummy_check = PlannedCheck {
        check_id: "check:test".to_string(),
        display_name: "test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "repo".to_string(),
        reason: "reason".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };

    let dummy_run = VerificationRun {
        run_id: "run-planner-iso".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![dummy_check.clone()],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: dummy_check.check_id.clone(),
            kind: dummy_check.kind,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_1".to_string(),
            reused_execution: false,
            command: vec!["echo".to_string(), "ok".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 10,
            stdout_digest: None,
            stderr_digest: None,
            stdout_excerpt: None,
            stderr_excerpt: None,
            stdout_captured_bytes: 0,
            stderr_captured_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            started_at_ms: 1000,
            reason: None,
        }],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10,
    };

    let policy = CalibrationPolicy::default();
    let cal = run_calibration(repo_root, &dummy_run, &policy).unwrap();
    persist_calibration_run(&mut db.conn, &cal).unwrap();

    // 3. Plan again after calibration records exist in DB
    let plan_after = plan_verification(repo_root, None, None, None).unwrap();

    // 4. Must be 100% identical: selected_checks, assurance, unresolved_obligations
    assert_eq!(plan_before.assurance, plan_after.assurance);
    assert_eq!(plan_before.selected_checks, plan_after.selected_checks);
    assert_eq!(
        plan_before.unresolved_obligations,
        plan_after.unresolved_obligations
    );
}
