use fdx::intelligence::attestation::*;
use fdx::intelligence::change::uncertainty::UncertaintyReason;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::*;
use fdx::intelligence::verify::model::*;
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_uncertainty_preservation_and_redaction() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    let run_id = "run-uncertainty-1";

    let planned = PlannedCheck {
        check_id: "check:test".to_string(),
        display_name: "check:test".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:.".to_string(),
        reason: "evidence".to_string(),
        selection: SelectionReason::Evidence,
        strength: fdx::protocol::EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: true,
    };

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
    };

    let run = VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Degraded,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![planned],
            uncertainty: vec![UncertaintyReason::UnsupportedLanguage(
                "Bearer secret-token-123".to_string(),
            )],
            unresolved_obligations: vec![UnresolvedVerificationObligation {
                scope: "pkg:unsupported".to_string(),
                reason: "no compiler support".to_string(),
                source: "unsupported_language".to_string(),
            }],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Degraded,
        checks: vec![check],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10,
    };

    persist_verification_run(repo_root, &run).unwrap();
    let artifact_path = repo_root
        .join(".fdx")
        .join("runs")
        .join(format!("{}.json", run_id));
    let raw_bytes = std::fs::read(&artifact_path).unwrap();

    let mut db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    ingest_verification_artifact(&mut db.conn, &raw_bytes).unwrap();

    let attestation = build_verification_attestation(repo_root, run_id, &db.conn).unwrap();
    assert_eq!(attestation.predicate.result.unresolved_obligation_count, 1);
    assert_eq!(attestation.predicate.uncertainty.len(), 1);
    assert_eq!(
        attestation.predicate.uncertainty[0].code,
        "unsupported_language"
    );
    assert!(!attestation.predicate.uncertainty[0]
        .message
        .contains("secret-token-123"));
}
