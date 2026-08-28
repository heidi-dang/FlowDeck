use fdx::intelligence::change::model::{SemanticChange, SemanticChangeKind};
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::cooccurrence::query_check_cooccurrences;
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, VerificationOutcome, VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

#[test]
fn test_runtime_cooccurrence_observations_query() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let check_id = "test:npm:tests/feature.test.ts";
    let run = VerificationRun {
        run_id: "run_cooc_1".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![SemanticChange {
                id: "ch_1".to_string(),
                file: "src/feature.ts".to_string(),
                symbol: None,
                change_kind: SemanticChangeKind::ImplementationChanged,
                before: None,
                after: None,
                evidence: vec![],
                assurance: AssuranceLevel::Exact,
                reasons: vec![],
            }],
            impacted_targets: vec![],
            selected_checks: vec![PlannedCheck {
                check_id: check_id.to_string(),
                display_name: check_id.to_string(),
                kind: VerificationCheckKind::UnitTest,
                scope: "pkg:npm:.".to_string(),
                reason: "changed".to_string(),
                selection: SelectionReason::Evidence,
                strength: EvidenceStrength::Precise,
                evidence_path: None,
                evidence_refs: vec![],
                widening_reason: None,
                mandatory: true,
            }],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Passed,
        assurance: AssuranceLevel::Exact,
        checks: vec![CheckExecutionResult {
            check_id: check_id.to_string(),
            kind: VerificationCheckKind::UnitTest,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_1".to_string(),
            reused_execution: false,
            command: vec!["npm".to_string()],
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
        persistence_status: fdx::intelligence::verify::model::PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 20,
    };

    let bytes = serde_json::to_vec(&run).unwrap();
    ingest_verification_artifact(&mut db.conn, &bytes).unwrap();

    let coocs = query_check_cooccurrences(&db.conn, check_id).unwrap();
    assert_eq!(coocs.len(), 1);
    assert_eq!(coocs[0].entity_id, "src/feature.ts");
    assert_eq!(coocs[0].run_count, 1);
}
