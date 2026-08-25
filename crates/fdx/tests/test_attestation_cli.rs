use fdx::intelligence::attestation::*;
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::*;
use fdx::intelligence::verify::model::*;
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::AssuranceLevel;
use tempfile::tempdir;

#[test]
fn test_attest_create_show_verify_roundtrip() {
    let tmp = tempdir().unwrap();
    let repo_root = tmp.path();
    let run_id = "run-cli-roundtrip";

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
    let (att_path, _sha) = persist_attestation(repo_root, &attestation).unwrap();

    let (loaded, raw_att_bytes, _file_sha) =
        load_attestation_from_path(repo_root, &att_path, None).unwrap();
    assert_eq!(loaded.predicate.run.run_id, run_id);

    let report =
        verify_attestation(repo_root, &loaded, Some(&raw_att_bytes), None, &db.conn).unwrap();
    assert!(report.valid);

    let binary = env!("CARGO_BIN_EXE_fdx");
    let v1_output = std::process::Command::new(binary)
        .current_dir(repo_root)
        .args(["attest", "create", "--run", run_id, "--format", "json"])
        .output()
        .unwrap();
    assert!(v1_output.status.success());
    let v1: serde_json::Value = serde_json::from_slice(&v1_output.stdout).unwrap();
    assert_eq!(v1["predicate_version"], "v1");
    assert_eq!(
        v1["statement"]["predicateType"],
        fdx::intelligence::attestation::FDX_VERIFICATION_PREDICATE_V1_TYPE
    );

    let v2_output = std::process::Command::new(binary)
        .current_dir(repo_root)
        .args([
            "attest",
            "create",
            "--run",
            run_id,
            "--predicate-version",
            "v2",
            "--format",
            "json",
        ])
        .output()
        .unwrap();
    assert!(v2_output.status.success());
    let v2: serde_json::Value = serde_json::from_slice(&v2_output.stdout).unwrap();
    assert_eq!(v2["predicate_version"], "v2");
    assert_eq!(
        v2["statement"]["predicateType"],
        fdx::intelligence::attestation::FDX_VERIFICATION_PREDICATE_V2_TYPE
    );
    assert!(v2["statement"]["predicate"].get("policy_context").is_none());

    let v2_path = v2["path"].as_str().unwrap();
    let verify_output = std::process::Command::new(binary)
        .current_dir(repo_root)
        .args(["attest", "verify", v2_path, "--format", "json"])
        .output()
        .unwrap();
    assert!(
        verify_output.status.success(),
        "{}",
        String::from_utf8_lossy(&verify_output.stderr)
    );
}
