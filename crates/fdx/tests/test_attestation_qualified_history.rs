use fdx::intelligence::attestation::*;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::testplan::model::*;
use fdx::intelligence::verify::model::*;
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_requires_qualified_m8_history() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    let run_id = "run-no-m8";

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
        command: vec!["echo".to_string()],
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
        started_at_ms: 1000,
        reason: None,
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
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 1,
    };

    persist_verification_run(repo_root, &run).unwrap();

    let db = EvidenceDatabase::open(repo_root, DatabaseOpenMode::ReadWrite).unwrap();
    // Do not ingest into M8 yet -> should fail closed
    let err = build_verification_attestation(repo_root, run_id, &db.conn).unwrap_err();
    assert!(err.contains("not found in runtime history database"));
}
