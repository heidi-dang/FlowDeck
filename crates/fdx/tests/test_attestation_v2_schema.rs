use fdx::intelligence::attestation::{
    build_verification_attestation, build_verification_attestation_v2, canonicalize_to_vec,
    load_attestation_document_from_path, persist_attestation_v2, AttestationDocument,
    FDX_VERIFICATION_PREDICATE_V2_TYPE,
};
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::{ingest_verification_artifact, sha256_bytes};
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::TempDir;

fn base_only_fixture() -> (TempDir, EvidenceDatabase, String) {
    let temp = tempfile::tempdir().unwrap();
    let run_id = "run-m12-v2-base".to_string();
    let check = PlannedCheck {
        check_id: "check:base".to_string(),
        display_name: "base check".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:.".to_string(),
        reason: "real fixture evidence".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    };
    let execution = CheckExecutionResult {
        check_id: check.check_id.clone(),
        kind: check.kind,
        status: CheckExecutionStatus::Passed,
        execution_id: "exec:m12-base".to_string(),
        reused_execution: false,
        command: vec!["true".to_string()],
        cwd: ".".to_string(),
        exit_code: Some(0),
        signal: None,
        duration_ms: 1,
        stdout_digest: None,
        stderr_digest: None,
        stdout_excerpt: None,
        stderr_excerpt: None,
        stdout_captured_bytes: 0,
        stderr_captured_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        started_at_ms: 100,
        reason: None,
    };
    let run = VerificationRun {
        run_id: run_id.clone(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![check],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![execution],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 100,
        duration_ms: 1,
    };
    persist_verification_run(temp.path(), &run).unwrap();
    let artifact = std::fs::read(
        temp.path()
            .join(".fdx")
            .join("runs")
            .join(format!("{run_id}.json")),
    )
    .unwrap();
    let mut db = EvidenceDatabase::open(temp.path(), DatabaseOpenMode::ReadWrite).unwrap();
    ingest_verification_artifact(&mut db.conn, &artifact).unwrap();
    (temp, db, run_id)
}

#[test]
fn v2_base_only_uses_v1_projection_without_fake_policy_application() {
    let (temp, db, run_id) = base_only_fixture();
    let v1_before = build_verification_attestation(temp.path(), &run_id, &db.conn).unwrap();
    let v2 = build_verification_attestation_v2(temp.path(), &run_id, &db.conn).unwrap();
    let v1_after = build_verification_attestation(temp.path(), &run_id, &db.conn).unwrap();

    assert_eq!(
        canonicalize_to_vec(&v1_before).unwrap(),
        canonicalize_to_vec(&v1_after).unwrap()
    );
    assert_eq!(v2.predicate_type, FDX_VERIFICATION_PREDICATE_V2_TYPE);
    assert_eq!(v2.predicate.schema_version, 2);
    assert!(v2.predicate.policy_context.is_none());
    assert_eq!(v2.predicate.run, v1_before.predicate.run);
    assert_eq!(v2.predicate.plan, v1_before.predicate.plan);

    let (path, sha256) = persist_attestation_v2(temp.path(), &v2).unwrap();
    let loaded = load_attestation_document_from_path(temp.path(), &path, None).unwrap();
    assert_eq!(loaded.sha256, sha256);
    match loaded.document {
        AttestationDocument::V2(statement) => assert_eq!(*statement, v2),
        AttestationDocument::V1(_) => panic!("v2 artifact was classified as v1"),
    }
}

#[test]
fn v2_creation_is_deterministic_and_survives_database_reopen_offline() {
    let (temp, db, run_id) = base_only_fixture();
    let first = build_verification_attestation_v2(temp.path(), &run_id, &db.conn).unwrap();
    let first_bytes = canonicalize_to_vec(&first).unwrap();
    drop(db);

    // Reopen only local SQLite evidence and reconstruct without any network-capable dependency.
    let reopened = EvidenceDatabase::open(temp.path(), DatabaseOpenMode::ReadOnly).unwrap();
    let second = build_verification_attestation_v2(temp.path(), &run_id, &reopened.conn).unwrap();
    let second_bytes = canonicalize_to_vec(&second).unwrap();
    assert_eq!(first, second);
    assert_eq!(first_bytes, second_bytes);
    fdx::intelligence::attestation::verify_attestation_v2(
        temp.path(),
        &second,
        Some(&second_bytes),
        Some(&sha256_bytes(&second_bytes)),
        &reopened.conn,
    )
    .unwrap();
}

#[test]
fn strict_dispatch_rejects_unknown_fields_and_future_predicates() {
    let (temp, db, run_id) = base_only_fixture();
    let v2 = build_verification_attestation_v2(temp.path(), &run_id, &db.conn).unwrap();
    let mut value = serde_json::to_value(&v2).unwrap();
    value["unexpected"] = serde_json::json!(true);
    let bytes = serde_json::to_vec(&value).unwrap();
    let path = temp.path().join("external-unknown-field.json");
    std::fs::write(&path, &bytes).unwrap();
    let error =
        load_attestation_document_from_path(temp.path(), &path, Some(&sha256_bytes(&bytes)))
            .unwrap_err();
    assert!(error.contains("strictly parse v2"));

    let mut future = serde_json::to_value(&v2).unwrap();
    future["predicateType"] =
        serde_json::json!("https://flowdeck.dev/attestation/vci/verification/v3");
    let future_bytes = serde_json::to_vec(&future).unwrap();
    let future_path = temp.path().join("external-v3.json");
    std::fs::write(&future_path, &future_bytes).unwrap();
    let error = load_attestation_document_from_path(
        temp.path(),
        &future_path,
        Some(&sha256_bytes(&future_bytes)),
    )
    .unwrap_err();
    assert!(error.contains("unsupported attestation predicateType"));
}
