//! Tests for comprehensive verifier completeness across all check, execution, and plan fields.

use fdx::intelligence::attestation::build_verification_attestation;
use fdx::intelligence::attestation::verify::verify_attestation;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

fn setup_test_run(run_id: &str) -> (tempfile::TempDir, VerificationRun) {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();

    let check = CheckExecutionResult {
        check_id: "check:test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        status: CheckExecutionStatus::Passed,
        execution_id: "exec:1".to_string(),
        reused_execution: false,
        command: vec!["cargo".to_string(), "test".to_string()],
        cwd: ".".to_string(),
        exit_code: Some(0),
        signal: None,
        duration_ms: 15,
        stdout_digest: Some("sha256:abc".to_string()),
        stderr_digest: Some("sha256:def".to_string()),
        stdout_excerpt: None,
        stderr_excerpt: None,
        stdout_captured_bytes: 10,
        stderr_captured_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        started_at_ms: 1000,
        reason: None,
    };

    let planned = PlannedCheck {
        check_id: "check:test".to_string(),
        display_name: "check:test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "workspace:root".to_string(),
        reason: "changed".to_string(),
        selection: SelectionReason::Evidence,
        strength: fdx::protocol::EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    };

    let run = VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![planned],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![check],
        uncertainty: vec![],
        base: Some("main".to_string()),
        head: Some("HEAD".to_string()),
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 20,
    };

    persist_verification_run(repo_root, &run).unwrap();

    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    let artifact_path = repo_root
        .join(".fdx")
        .join("runs")
        .join(format!("{}.json", run_id));
    let raw_bytes = std::fs::read(&artifact_path).unwrap();
    ingest_verification_artifact(&mut db.conn, &raw_bytes).unwrap();

    (tmp, run)
}

#[test]
fn test_check_field_tampering_matrix() {
    let (tmp, run) = setup_test_run("run-check-matrix");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    // 1. Mutate check.kind
    let mut bad1 = attestation.clone();
    bad1.predicate.checks[0].kind = VerificationCheckKind::Lint;
    assert!(verify_attestation(repo_root, &bad1, None, None, &db.conn).is_err());

    // 2. Mutate check.mandatory
    let mut bad2 = attestation.clone();
    bad2.predicate.checks[0].mandatory = false;
    assert!(verify_attestation(repo_root, &bad2, None, None, &db.conn).is_err());

    // 3. Mutate check.execution_id
    let mut bad3 = attestation.clone();
    bad3.predicate.checks[0].execution_id = "exec:fake".to_string();
    assert!(verify_attestation(repo_root, &bad3, None, None, &db.conn).is_err());

    // 4. Mutate check.reused_execution
    let mut bad4 = attestation.clone();
    bad4.predicate.checks[0].reused_execution = true;
    assert!(verify_attestation(repo_root, &bad4, None, None, &db.conn).is_err());
}

#[test]
fn test_execution_field_tampering_matrix() {
    let (tmp, run) = setup_test_run("run-exec-matrix");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    // 1. Mutate program
    let mut bad1 = attestation.clone();
    bad1.predicate.executions[0].program = "npm".to_string();
    assert!(verify_attestation(repo_root, &bad1, None, None, &db.conn).is_err());

    // 2. Mutate argv_digest
    let mut bad2 = attestation.clone();
    bad2.predicate.executions[0].argv_digest = "sha256:fake".to_string();
    assert!(verify_attestation(repo_root, &bad2, None, None, &db.conn).is_err());

    // 3. Mutate cwd
    let mut bad3 = attestation.clone();
    bad3.predicate.executions[0].cwd = "/other".to_string();
    assert!(verify_attestation(repo_root, &bad3, None, None, &db.conn).is_err());

    // 4. Mutate status
    let mut bad4 = attestation.clone();
    bad4.predicate.executions[0].status = CheckExecutionStatus::Failed;
    assert!(verify_attestation(repo_root, &bad4, None, None, &db.conn).is_err());

    // 5. Mutate exit_code
    let mut bad5 = attestation.clone();
    bad5.predicate.executions[0].exit_code = Some(1);
    assert!(verify_attestation(repo_root, &bad5, None, None, &db.conn).is_err());

    // 6. Mutate duration_ms
    let mut bad6 = attestation.clone();
    bad6.predicate.executions[0].duration_ms = 99999;
    assert!(verify_attestation(repo_root, &bad6, None, None, &db.conn).is_err());

    // 7. Mutate stdout_digest
    let mut bad7 = attestation.clone();
    bad7.predicate.executions[0].stdout_digest = Some("sha256:tampered".to_string());
    assert!(verify_attestation(repo_root, &bad7, None, None, &db.conn).is_err());

    // 8. Mutate stderr_digest
    let mut bad8 = attestation.clone();
    bad8.predicate.executions[0].stderr_digest = Some("sha256:tampered".to_string());
    assert!(verify_attestation(repo_root, &bad8, None, None, &db.conn).is_err());

    // 9. Mutate stdout_captured_bytes
    let mut bad9 = attestation.clone();
    bad9.predicate.executions[0].stdout_captured_bytes = 10000;
    assert!(verify_attestation(repo_root, &bad9, None, None, &db.conn).is_err());

    // 10. Mutate stderr_captured_bytes
    let mut bad10 = attestation.clone();
    bad10.predicate.executions[0].stderr_captured_bytes = 10000;
    assert!(verify_attestation(repo_root, &bad10, None, None, &db.conn).is_err());

    // 11. Mutate output_truncated
    let mut bad11 = attestation.clone();
    bad11.predicate.executions[0].output_truncated = true;
    assert!(verify_attestation(repo_root, &bad11, None, None, &db.conn).is_err());
}

#[test]
fn test_plan_and_run_metadata_tampering() {
    let (tmp, run) = setup_test_run("run-meta-matrix");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    // 1. Mutate executed_at_ms
    let mut bad1 = attestation.clone();
    bad1.predicate.run.executed_at_ms = 9999;
    assert!(verify_attestation(repo_root, &bad1, None, None, &db.conn).is_err());

    // 2. Mutate duration_ms
    let mut bad2 = attestation.clone();
    bad2.predicate.run.duration_ms = 9999;
    assert!(verify_attestation(repo_root, &bad2, None, None, &db.conn).is_err());

    // 3. Mutate total_obligations
    let mut bad3 = attestation.clone();
    bad3.predicate.plan.total_obligations = 10;
    assert!(verify_attestation(repo_root, &bad3, None, None, &db.conn).is_err());

    // 4. Mutate mandatory_obligations
    let mut bad4 = attestation.clone();
    bad4.predicate.plan.mandatory_obligations = 0;
    assert!(verify_attestation(repo_root, &bad4, None, None, &db.conn).is_err());
}
