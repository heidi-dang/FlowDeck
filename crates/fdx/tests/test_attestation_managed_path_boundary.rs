//! Tests for explicit managed vs external attestation path classification.

use fdx::intelligence::attestation::build_verification_attestation;
use fdx::intelligence::attestation::persist::{
    classify_attestation_source, persist_attestation, AttestationSource,
};
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
fn test_classify_attestation_source_managed_vs_external() {
    let (tmp, run) = setup_test_run("run-classify-source");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    let (managed_path, att_sha) = persist_attestation(repo_root, &attestation).unwrap();

    // 1. Managed path classification
    let src1 = classify_attestation_source(repo_root, &managed_path, None).unwrap();
    assert!(matches!(src1, AttestationSource::Managed { .. }));

    // 2. External copy with content-addressed name without expected SHA must fail
    let tmp_outside = tempdir().unwrap();
    let ext_path = tmp_outside
        .path()
        .join(format!("{}.{}.json", run.run_id, att_sha));
    std::fs::copy(&managed_path, &ext_path).unwrap();

    let src2_err = classify_attestation_source(repo_root, &ext_path, None);
    assert!(src2_err.is_err());
    assert!(src2_err.unwrap_err().contains("requires --expected-sha256"));

    // 3. External copy with expected SHA classifies as External
    let src3 = classify_attestation_source(repo_root, &ext_path, Some(&att_sha)).unwrap();
    assert!(matches!(src3, AttestationSource::External { .. }));
}
