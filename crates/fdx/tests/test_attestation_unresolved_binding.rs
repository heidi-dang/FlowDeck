//! Tests for structured unresolved obligations preservation and verification.

use fdx::intelligence::attestation::{build_verification_attestation, verify_attestation};
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::{UnresolvedVerificationObligation, VerificationPlan};
use fdx::intelligence::verify::model::{PersistenceStatus, VerificationOutcome, VerificationRun};
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_structured_unresolved_obligations_preserved_and_redacted() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();

    let run_id = "run-test-unresolved-struct";
    let unres = UnresolvedVerificationObligation {
        scope: "pkg:secret_token_1234567890abcdef".to_string(),
        reason: "Authorization: Bearer sk-ant-api03-verysecretkey required".to_string(),
        source: "language:unsupported_rust".to_string(),
    };

    let run = VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Degraded,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![],
            uncertainty: vec![],
            unresolved_obligations: vec![unres],
        },
        outcome: VerificationOutcome::Incomplete,
        assurance: AssuranceLevel::Degraded,
        checks: vec![],
        uncertainty: vec![],
        base: None,
        head: None,
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

    let attestation = build_verification_attestation(repo_root, run_id, &db.conn).unwrap();

    assert_eq!(attestation.predicate.result.unresolved_obligation_count, 1);
    assert_eq!(attestation.predicate.result.unresolved_obligations.len(), 1);

    let attested_u = &attestation.predicate.result.unresolved_obligations[0];
    assert_eq!(attested_u.source, "language:unsupported_rust");
    assert!(!attested_u.reason.contains("sk-ant-api03-verysecretkey"));
    assert!(attested_u.reason.contains("[REDACTED]"));

    let report = verify_attestation(repo_root, &attestation, None, None, &db.conn).unwrap();
    assert!(report.valid);
}

#[test]
fn test_unresolved_obligation_tamper_rejected() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();

    let run_id = "run-test-unresolved-tamper";
    let unres = UnresolvedVerificationObligation {
        scope: "pkg:rust-service".to_string(),
        reason: "no compiler toolchain".to_string(),
        source: "language:rust".to_string(),
    };

    let run = VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Degraded,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![],
            uncertainty: vec![],
            unresolved_obligations: vec![unres],
        },
        outcome: VerificationOutcome::Incomplete,
        assurance: AssuranceLevel::Degraded,
        checks: vec![],
        uncertainty: vec![],
        base: None,
        head: None,
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

    let attestation = build_verification_attestation(repo_root, run_id, &db.conn).unwrap();

    // 1. Mutate scope
    let mut bad_att = attestation.clone();
    bad_att.predicate.result.unresolved_obligations[0].scope = "pkg:tampered".to_string();
    assert!(verify_attestation(repo_root, &bad_att, None, None, &db.conn).is_err());

    // 2. Mutate reason
    let mut bad_att2 = attestation.clone();
    bad_att2.predicate.result.unresolved_obligations[0].reason = "tampered reason".to_string();
    assert!(verify_attestation(repo_root, &bad_att2, None, None, &db.conn).is_err());

    // 3. Mutate source
    let mut bad_att3 = attestation.clone();
    bad_att3.predicate.result.unresolved_obligations[0].source = "language:tampered".to_string();
    assert!(verify_attestation(repo_root, &bad_att3, None, None, &db.conn).is_err());

    // 4. Mutate count
    let mut bad_att4 = attestation.clone();
    bad_att4.predicate.result.unresolved_obligation_count = 99;
    assert!(verify_attestation(repo_root, &bad_att4, None, None, &db.conn).is_err());
}
