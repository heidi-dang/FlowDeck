use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::digest::sha256_bytes;
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::runtime::model::RuntimeIngestResult;
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use rusqlite::params;
use tempfile::tempdir;

fn sample_run(run_id: &str) -> VerificationRun {
    VerificationRun {
        run_id: run_id.to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![PlannedCheck {
                check_id: "check:test".to_string(),
                display_name: "test".to_string(),
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
            check_id: "check:test".to_string(),
            kind: VerificationCheckKind::UnitTest,
            status: CheckExecutionStatus::Passed,
            execution_id: "exec_1".to_string(),
            reused_execution: false,
            command: vec!["npm".to_string(), "test".to_string()],
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
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1000,
        duration_ms: 10,
    }
}

#[test]
fn test_exact_artifact_bytes_sha_stored_in_database() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = sample_run("run_exact_1");
    let raw_bytes = serde_json::to_vec(&run).unwrap();
    let expected_digest = sha256_bytes(&raw_bytes);

    let res = ingest_verification_artifact(&mut db.conn, &raw_bytes).unwrap();
    assert_eq!(
        res,
        RuntimeIngestResult::Imported {
            run_id: "run_exact_1".to_string(),
            artifact_digest: expected_digest.clone(),
        }
    );

    let stored_digest: String = db
        .conn
        .query_row(
            "SELECT artifact_digest FROM runtime_runs WHERE run_id = ?1",
            params!["run_exact_1"],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(stored_digest, expected_digest);
}

#[test]
fn test_formatting_only_mutation_produces_artifact_digest_conflict() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = sample_run("run_fmt_1");
    let raw_bytes_compact = serde_json::to_vec(&run).unwrap();
    let raw_bytes_pretty = serde_json::to_vec_pretty(&run).unwrap();

    assert_ne!(raw_bytes_compact, raw_bytes_pretty);

    let res1 = ingest_verification_artifact(&mut db.conn, &raw_bytes_compact).unwrap();
    assert!(matches!(res1, RuntimeIngestResult::Imported { .. }));

    let res2 = ingest_verification_artifact(&mut db.conn, &raw_bytes_pretty).unwrap();
    assert!(matches!(
        res2,
        RuntimeIngestResult::Conflict {
            run_id,
            existing_digest,
            incoming_digest
        } if run_id == "run_fmt_1" && existing_digest != incoming_digest
    ));
}

#[test]
fn test_exact_bytes_reimport_is_already_imported() {
    let dir = tempdir().unwrap();
    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let run = sample_run("run_idemp_1");
    let raw_bytes = serde_json::to_vec(&run).unwrap();

    let res1 = ingest_verification_artifact(&mut db.conn, &raw_bytes).unwrap();
    assert!(matches!(res1, RuntimeIngestResult::Imported { .. }));

    let res2 = ingest_verification_artifact(&mut db.conn, &raw_bytes).unwrap();
    assert!(matches!(res2, RuntimeIngestResult::AlreadyImported { .. }));
}
