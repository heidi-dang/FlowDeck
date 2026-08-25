use fdx::intelligence::attestation::*;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::*;
use fdx::intelligence::verify::model::*;
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_plan_digest_binding_and_obligation_counts() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    let run_id = "run-plan-binding";

    let planned_mandatory = PlannedCheck {
        check_id: "check:mandatory".to_string(),
        display_name: "check:mandatory".to_string(),
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

    let planned_advisory = PlannedCheck {
        check_id: "check:advisory".to_string(),
        display_name: "check:advisory".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope: "pkg:npm:.".to_string(),
        reason: "evidence".to_string(),
        selection: SelectionReason::Evidence,
        strength: fdx::protocol::EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    };

    let check1 = CheckExecutionResult {
        check_id: "check:mandatory".to_string(),
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

    let check2 = CheckExecutionResult {
        check_id: "check:advisory".to_string(),
        kind: VerificationCheckKind::UnitTest,
        status: CheckExecutionStatus::Passed,
        execution_id: "exec:2".to_string(),
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
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![planned_mandatory, planned_advisory],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![check1, check2],
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 20,
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
    assert_eq!(attestation.predicate.plan.total_obligations, 2);
    assert_eq!(attestation.predicate.plan.mandatory_obligations, 1);
    assert_eq!(attestation.predicate.plan.advisory_obligations, 1);
}
