use fdx::intelligence::attestation::*;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::*;
use fdx::intelligence::verify::model::*;
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_shared_execution_binding_n_checks_one_exec() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    let run_id = "run-shared-exec";

    let mut checks = Vec::new();
    let mut planned = Vec::new();

    for i in 1..=3 {
        let check_id = format!("check:test:{}", i);
        planned.push(PlannedCheck {
            check_id: check_id.clone(),
            display_name: check_id.clone(),
            kind: VerificationCheckKind::UnitTest,
            scope: "pkg:npm:.".to_string(),
            reason: "evidence".to_string(),
            selection: SelectionReason::Evidence,
            strength: fdx::protocol::EvidenceStrength::Precise,
            evidence_path: None,
            evidence_refs: vec![],
            widening_reason: None,
            mandatory: true,
        });

        checks.push(CheckExecutionResult {
            check_id,
            kind: VerificationCheckKind::UnitTest,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec:shared:1".to_string(),
            reused_execution: i > 1,
            command: vec!["cargo".to_string(), "test".to_string()],
            cwd: ".".to_string(),
            exit_code: Some(0),
            signal: None,
            duration_ms: 20,
            stdout_digest: Some("sha256:111".to_string()),
            stderr_digest: Some("sha256:222".to_string()),
            stdout_excerpt: None,
            stderr_excerpt: None,
            stdout_captured_bytes: 50,
            stderr_captured_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            started_at_ms: 1000,
            reason: None,
        });
    }

    let run = VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: planned,
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks,
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
    assert_eq!(attestation.predicate.checks.len(), 3);
    assert_eq!(attestation.predicate.executions.len(), 1);
    assert_eq!(
        attestation.predicate.executions[0].execution_id,
        "exec:shared:1"
    );
}
