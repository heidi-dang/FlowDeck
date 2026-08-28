use fdx::intelligence::attestation::{build_verification_attestation_v2, verify_attestation_v2};
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::policy::{
    compute_template_digest, persist_policy_application, plan_with_policy_overlay, revoke_policy,
};
use fdx::intelligence::runtime::ingest_verification_artifact;
use fdx::intelligence::testplan::model::{PlannedCheck, SelectionReason, VerificationCheckKind};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::intelligence::verify::persist::persist_verification_run;
use fdx::protocol::EvidenceStrength;
use rusqlite::params;
use std::process::Command;
use tempfile::TempDir;

fn git(path: &std::path::Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn passed_execution(check: &PlannedCheck, index: usize) -> CheckExecutionResult {
    CheckExecutionResult {
        check_id: check.check_id.clone(),
        kind: check.kind,
        status: CheckExecutionStatus::Passed,
        execution_id: format!("exec:m12-policy:{index}"),
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
        started_at_ms: 1_000 + index as u64,
        reason: None,
    }
}

fn insert_active_policy_fixture(
    db: &mut EvidenceDatabase,
    scope: &str,
    template: &PlannedCheck,
) -> String {
    let template_digest = compute_template_digest(template).unwrap();
    let candidate_id = "candidate-m12-policy";
    let candidate_digest = "candidate-digest-m12";
    let promotion_policy_digest = "promotion-policy-digest-m12";
    let policy_id = format!(
        "policy_{}",
        fdx::intelligence::runtime::sha256_bytes(
            format!(
                "{candidate_id}:{candidate_digest}:{promotion_policy_digest}:{template_digest}"
            )
            .as_bytes(),
        ),
    );
    let promoted_policy_digest = fdx::intelligence::runtime::sha256_bytes(
        format!(
            "1:{candidate_id}:add_check:scope:{scope}:{}:{template_digest}",
            template.check_id
        )
        .as_bytes(),
    );

    // This fixture is deliberately seeded at the persistence boundary: the M12 unit under test
    // consumes stored templates, policies, and applications, and checks their production digests.
    db.conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    db.conn
        .execute(
            r#"INSERT INTO policy_candidates (
            candidate_id, candidate_contract_version, trigger_kind, trigger_scope, check_id,
            candidate_digest, promotion_policy_digest, support_count,
            distinct_source_artifact_count, distinct_change_fingerprint_count,
            estimated_added_runtime_ms, state, created_at_ms, updated_at_ms, promoted_policy_id
        ) VALUES (?1, 1, 'scope', ?2, ?3, ?4, ?5, 3, 3, 3, 1, 'promoted', 100, 100, ?6)"#,
            params![
                candidate_id,
                scope,
                template.check_id,
                candidate_digest,
                promotion_policy_digest,
                &policy_id
            ],
        )
        .unwrap();
    db.conn
        .execute(
            r#"INSERT INTO calibration_runs (
            calibration_id, source_run_id, candidate_plan_digest, policy_digest, status,
            reference_scope, max_shadow_checks, reference_truncated, started_at_ms,
            completed_at_ms, duration_ms, created_at_ms, calibration_contract_version,
            source_artifact_sha256, record_digest, max_total_duration_ms,
            per_check_timeout_ms, max_output_bytes
        ) VALUES (
            'fixture-calibration', 'fixture-run', 'fixture-plan', 'fixture-policy', 'complete',
            'affected', 1, 0, 10, 11, 1, 11, 2, 'fixture-artifact', 'fixture-record', 10, 10, 1024
        )"#,
            [],
        )
        .unwrap();
    db.conn
        .execute(
            r#"INSERT INTO calibration_metrics (
            calibration_id, candidate_selected_count, shadow_reference_count,
            shadow_executed_count, selected_failure_count, unselected_failure_count,
            observed_shadow_miss_count, shadow_incomplete_count,
            candidate_execution_duration_ms, shadow_reference_duration_ms,
            selection_ratio, runtime_cost_ratio, signal_recall,
            eligible_for_miss_rate, eligible_for_cost_ratio,
            eligible_for_runtime_comparison, candidate_physical_execution_count,
            shadow_physical_execution_count
        ) VALUES ('fixture-calibration', 0, 1, 1, 0, 1, 1, 0, 0, 1, 0.0, 1.0, 1.0, 1, 1, 1, 0, 1)"#,
            [],
        )
        .unwrap();
    db.conn
        .execute(
            r#"INSERT INTO calibration_checks (
            calibration_id, check_id, candidate_selected, reference_selected,
            execution_status, has_physical_execution, duration_ms, signal_class,
            is_observed_shadow_miss, reason, display_name, kind, scope, execution_id,
            reused_execution
        ) VALUES (?1, ?2, 0, 1, 'failed', 1, 1, 'observed_shadow_miss', 1,
                  'fixture qualified non-policy shadow miss', ?2, 'unit_test', ?3,
                  'fixture-exec', 0)"#,
            params!["fixture-calibration", template.check_id, scope],
        )
        .unwrap();
    db.conn
        .execute(
            r#"INSERT INTO policy_candidate_evidence (
            candidate_id, calibration_id, source_artifact_sha256, candidate_plan_digest,
            calibration_record_digest, check_id, observed_at_ms
        ) VALUES (?1, 'fixture-calibration', 'fixture-artifact', 'fixture-plan',
                  'fixture-record', ?2, 11)"#,
            params![candidate_id, template.check_id],
        )
        .unwrap();
    db.conn
        .execute(
            r#"INSERT INTO policy_check_templates (
            template_digest, check_id, planned_check_json, source_calibration_id,
            source_artifact_sha256, source_record_digest, created_at_ms
        ) VALUES (?1, ?2, ?3, 'fixture-calibration', 'fixture-artifact', 'fixture-record', 100)"#,
            params![
                template_digest,
                template.check_id,
                serde_json::to_string(template).unwrap()
            ],
        )
        .unwrap();
    db.conn.execute(
        r#"INSERT INTO promoted_policies (
            policy_id, policy_contract_version, candidate_id, action, trigger_kind, trigger_scope,
            check_id, template_digest, candidate_digest, promotion_policy_digest,
            promoted_policy_digest, state, promoted_at_ms, revoked_at_ms, revoke_reason
        ) VALUES (?1, 1, ?2, 'add_check', 'scope', ?3, ?4, ?5, ?6, ?7, ?8, 'promoted', 100, NULL, NULL)"#,
        params![&policy_id, candidate_id, scope, template.check_id, template_digest, candidate_digest, promotion_policy_digest, promoted_policy_digest],
    ).unwrap();
    db.conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    policy_id
}

fn policy_attestation_fixture() -> (TempDir, EvidenceDatabase, String, String) {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("package.json"),
        r#"{"name":"m12-policy-fixture","scripts":{"test":"node -e \"process.exit(0)\""}}"#,
    )
    .unwrap();
    std::fs::write(temp.path().join("src.js"), "module.exports = 1;\n").unwrap();
    git(temp.path(), &["init"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    git(temp.path(), &["config", "user.name", "M12 Test"]);
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-m", "initial"]);
    std::fs::write(temp.path().join("src.js"), "module.exports = 2;\n").unwrap();

    let mut db = EvidenceDatabase::open(temp.path(), DatabaseOpenMode::ReadWrite).unwrap();
    let base =
        fdx::intelligence::testplan::planner::plan_verification(temp.path(), None, None, None)
            .unwrap();
    let scope = base
        .selected_checks
        .first()
        .expect("discovery must yield a base check")
        .scope
        .clone();
    let template = PlannedCheck {
        check_id: "policy:m12:add-check".to_string(),
        display_name: "M12 policy-added check".to_string(),
        kind: VerificationCheckKind::UnitTest,
        scope,
        reason: "stored exact template for M12 lifecycle fixture".to_string(),
        selection: SelectionReason::PolicyWidening,
        strength: EvidenceStrength::Structural,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: Some("learned_policy_add_check".to_string()),
        mandatory: false,
    };
    let policy_id = insert_active_policy_fixture(&mut db, &template.scope, &template);
    let effective = plan_with_policy_overlay(temp.path(), &db.conn, None, None).unwrap();
    assert_eq!(effective.added_check_ids, vec![template.check_id.clone()]);
    persist_policy_application(&db.conn, &effective.application, 1_000).unwrap();

    let run_id = "run-m12-policy-history".to_string();
    let run = VerificationRun {
        run_id: run_id.clone(),
        plan: effective.plan.clone(),
        outcome: VerificationOutcome::Passed,
        assurance: effective.plan.assurance,
        checks: effective
            .plan
            .selected_checks
            .iter()
            .enumerate()
            .map(|(index, check)| passed_execution(check, index))
            .collect(),
        uncertainty: effective.plan.uncertainty.clone(),
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1_000,
        duration_ms: 2,
    };
    persist_verification_run(temp.path(), &run).unwrap();
    let artifact = std::fs::read(
        temp.path()
            .join(".fdx")
            .join("runs")
            .join(format!("{run_id}.json")),
    )
    .unwrap();
    ingest_verification_artifact(&mut db.conn, &artifact).unwrap();
    (temp, db, run_id, policy_id)
}

#[test]
fn v2_binds_exact_policy_application_and_survives_later_revocation() {
    let (temp, mut db, run_id, policy_id) = policy_attestation_fixture();
    let v2 = build_verification_attestation_v2(temp.path(), &run_id, &db.conn).unwrap();
    let context = v2
        .predicate
        .policy_context
        .as_ref()
        .expect("overlay run needs v2 policy context");
    assert_eq!(context.added_check_ids, vec!["policy:m12:add-check"]);
    assert_eq!(context.applied_policy_ids, vec![policy_id.clone()]);
    assert_eq!(context.applied_policies.len(), 1);
    assert_eq!(context.policy_contract_version, 1);
    verify_attestation_v2(temp.path(), &v2, None, None, &db.conn).unwrap();

    revoke_policy(
        &mut db.conn,
        &policy_id,
        "M12 historical revocation test",
        2_000,
    )
    .unwrap();
    verify_attestation_v2(temp.path(), &v2, None, None, &db.conn).unwrap();
}

#[test]
fn v2_fails_closed_for_context_and_persisted_application_tampering() {
    let (temp, db, run_id, _policy_id) = policy_attestation_fixture();
    let v2 = build_verification_attestation_v2(temp.path(), &run_id, &db.conn).unwrap();
    let mut tampered_context = v2.clone();
    tampered_context
        .predicate
        .policy_context
        .as_mut()
        .unwrap()
        .added_check_ids = vec!["attacker:replacement".to_string()];
    assert!(verify_attestation_v2(temp.path(), &tampered_context, None, None, &db.conn).is_err());

    db.conn
        .execute(
            "UPDATE policy_applications SET added_check_ids_json = '[\"attacker:replacement\"]'",
            [],
        )
        .unwrap();
    let error = build_verification_attestation_v2(temp.path(), &run_id, &db.conn).unwrap_err();
    assert!(error.contains("invalid canonical identity"));
}
