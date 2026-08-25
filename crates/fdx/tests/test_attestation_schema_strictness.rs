//! Tests for strict schema enforcement, unknown field rejection, and canonical byte enforcement.

use fdx::intelligence::attestation::model::VerificationAttestation;
use fdx::intelligence::attestation::verify::verify_attestation;
use fdx::intelligence::attestation::{build_verification_attestation, persist_attestation};
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
fn test_unknown_fields_rejected_by_deserializer() {
    let (tmp, run) = setup_test_run("run-schema-strict");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    let json_val = serde_json::to_value(&attestation).unwrap();

    // 1. Unknown field on top level
    let mut bad_top = json_val.clone();
    bad_top
        .as_object_mut()
        .unwrap()
        .insert("extra_field".to_string(), serde_json::json!("unsupported"));
    let res1: Result<VerificationAttestation, _> = serde_json::from_value(bad_top);
    assert!(res1.is_err());
    assert!(res1.unwrap_err().to_string().contains("unknown field"));

    // 2. Unknown field in predicate
    let mut bad_pred = json_val.clone();
    bad_pred
        .get_mut("predicate")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .insert("custom_claim".to_string(), serde_json::json!(true));
    let res2: Result<VerificationAttestation, _> = serde_json::from_value(bad_pred);
    assert!(res2.is_err());
    assert!(res2.unwrap_err().to_string().contains("unknown field"));

    // 3. Unknown field in checks
    let mut bad_check = json_val.clone();
    bad_check
        .get_mut("predicate")
        .unwrap()
        .get_mut("checks")
        .unwrap()
        .get_mut(0)
        .unwrap()
        .as_object_mut()
        .unwrap()
        .insert("extra_check_prop".to_string(), serde_json::json!("bad"));
    let res3: Result<VerificationAttestation, _> = serde_json::from_value(bad_check);
    assert!(res3.is_err());
    assert!(res3.unwrap_err().to_string().contains("unknown field"));
}

#[test]
fn test_noncanonical_raw_bytes_rejected_by_verifier() {
    let (tmp, run) = setup_test_run("run-noncanonical");
    let repo_root = tmp.path();
    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadOnly).unwrap();
    let attestation = build_verification_attestation(repo_root, &run.run_id, &db.conn).unwrap();

    let (path, _sha) = persist_attestation(repo_root, &attestation).unwrap();
    let canonical_bytes = std::fs::read(&path).unwrap();

    // Insert extra whitespace in raw bytes
    let pretty_json = serde_json::to_vec_pretty(&attestation).unwrap();
    let res = verify_attestation(repo_root, &attestation, Some(&pretty_json), None, &db.conn);
    assert!(res.is_err());
    assert!(res
        .unwrap_err()
        .contains("Non-canonical raw attestation bytes rejected"));

    // Pass exact canonical bytes
    let valid_res = verify_attestation(
        repo_root,
        &attestation,
        Some(&canonical_bytes),
        None,
        &db.conn,
    );
    assert!(valid_res.is_ok());
}
