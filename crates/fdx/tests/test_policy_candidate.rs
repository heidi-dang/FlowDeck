use fdx::intelligence::migration::migrate_schema;
use fdx::intelligence::policy::{
    active_policy_snapshot, compute_template_digest, generate_candidates,
    load_persisted_overlay_templates, promote_candidate_with_materialized_template, revoke_policy,
    MaterializedPolicyTemplate, PolicyCheckTemplate, PolicyState, PolicyTemplateProvenance,
    PromotionPolicy,
};
use fdx::intelligence::testplan::model::{PlannedCheck, SelectionReason, VerificationCheckKind};
use fdx::protocol::EvidenceStrength;
use rusqlite::{params, Connection};

fn materialized_template(
    calibration_id: &str,
    artifact: &str,
    record: &str,
) -> MaterializedPolicyTemplate {
    materialized_template_for("cargo-test", calibration_id, artifact, record)
}

fn materialized_template_for(
    check_id: &str,
    calibration_id: &str,
    artifact: &str,
    record: &str,
) -> MaterializedPolicyTemplate {
    MaterializedPolicyTemplate {
        template: PolicyCheckTemplate {
            check: PlannedCheck {
                check_id: check_id.to_string(),
                display_name: check_id.to_string(),
                kind: VerificationCheckKind::Custom,
                scope: "pkg.alpha".to_string(),
                reason: "learned additive policy check for scope pkg.alpha".to_string(),
                selection: SelectionReason::PolicyWidening,
                strength: EvidenceStrength::Structural,
                evidence_path: None,
                evidence_refs: Vec::new(),
                widening_reason: Some("learned_policy_add_check".to_string()),
                mandatory: true,
            },
        },
        provenance: PolicyTemplateProvenance {
            source_calibration_id: calibration_id.to_string(),
            source_artifact_sha256: artifact.to_string(),
            source_record_digest: record.to_string(),
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_calibration_run(
    conn: &Connection,
    calibration_id: &str,
    started_at_ms: i64,
    calibration_contract_version: i64,
    status: &str,
    reference_truncated: bool,
    source_artifact_sha256: Option<&str>,
    record_digest: Option<&str>,
    eligible_for_miss_rate: bool,
    shadow_incomplete_count: i64,
) {
    conn.execute(
        r#"
        INSERT INTO calibration_runs (
            calibration_id, source_run_id, candidate_plan_digest, policy_digest, status,
            reference_scope, max_shadow_checks, reference_truncated, started_at_ms,
            completed_at_ms, duration_ms, created_at_ms, calibration_contract_version,
            source_artifact_sha256, record_digest, max_total_duration_ms,
            per_check_timeout_ms, max_output_bytes
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'affected', 5, ?6, ?7, ?8, 10, ?8, ?9, ?10, ?11, 1000, 100, 4096)
        "#,
        params![
            calibration_id,
            format!("run-{calibration_id}"),
            format!("plan-{calibration_id}"),
            format!("policy-{calibration_id}"),
            status,
            reference_truncated,
            started_at_ms,
            started_at_ms + 10,
            calibration_contract_version,
            source_artifact_sha256,
            record_digest,
        ],
    )
    .unwrap();
    conn.execute(
        r#"
        INSERT INTO calibration_metrics (
            calibration_id, candidate_selected_count, shadow_reference_count,
            shadow_executed_count, candidate_physical_execution_count,
            shadow_physical_execution_count, selected_failure_count,
            unselected_failure_count, observed_shadow_miss_count,
            shadow_incomplete_count, candidate_execution_duration_ms,
            shadow_reference_duration_ms, selection_ratio, runtime_cost_ratio,
            signal_recall, eligible_for_miss_rate, eligible_for_cost_ratio,
            eligible_for_runtime_comparison
        ) VALUES (?1, 1, 2, 1, 1, 1, 1, 1, 1, ?2, 10, 20, 0.5, 0.5, 0.5, ?3, ?3, ?3)
        "#,
        params![
            calibration_id,
            shadow_incomplete_count,
            eligible_for_miss_rate,
        ],
    )
    .unwrap();
}

#[allow(clippy::too_many_arguments)]
fn insert_calibration_check(
    conn: &Connection,
    calibration_id: &str,
    check_id: &str,
    scope: &str,
    candidate_selected: bool,
    reference_selected: bool,
    has_physical_execution: bool,
    execution_status: &str,
    signal_class: &str,
    is_observed_shadow_miss: bool,
    duration_ms: i64,
) {
    conn.execute(
        r#"
        INSERT INTO calibration_checks (
            calibration_id, check_id, candidate_selected, reference_selected,
            execution_status, has_physical_execution, duration_ms, signal_class,
            is_observed_shadow_miss, reason, display_name, kind, scope,
            execution_id, reused_execution
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?2, 'command', ?10, NULL, 0)
        "#,
        params![
            calibration_id,
            check_id,
            candidate_selected,
            reference_selected,
            execution_status,
            has_physical_execution,
            duration_ms,
            signal_class,
            is_observed_shadow_miss,
            scope,
        ],
    )
    .unwrap();
}

#[test]
fn test_generate_candidates_uses_only_qualified_current_contract_m10_evidence() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, 10).unwrap();

    insert_calibration_run(
        &conn,
        "qualified-newest",
        300,
        2,
        "complete",
        false,
        Some("artifact-a"),
        Some("record-a"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "qualified-newest",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        44,
    );

    insert_calibration_run(
        &conn,
        "qualified-second",
        200,
        2,
        "complete",
        false,
        Some("artifact-b"),
        Some("record-b"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "qualified-second",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        31,
    );

    insert_calibration_run(
        &conn,
        "legacy-contract",
        190,
        1,
        "complete",
        false,
        Some("artifact-legacy"),
        Some("record-legacy"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "legacy-contract",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        99,
    );

    insert_calibration_run(
        &conn,
        "incomplete-status",
        180,
        2,
        "incomplete",
        false,
        Some("artifact-c"),
        Some("record-c"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "incomplete-status",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "truncated-run",
        170,
        2,
        "complete",
        true,
        Some("artifact-d"),
        Some("record-d"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "truncated-run",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "missing-record",
        160,
        2,
        "complete",
        false,
        Some("artifact-e"),
        None,
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "missing-record",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "shadow-incomplete",
        150,
        2,
        "complete",
        false,
        Some("artifact-f"),
        Some("record-f"),
        true,
        1,
    );
    insert_calibration_check(
        &conn,
        "shadow-incomplete",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "not-eligible",
        140,
        2,
        "complete",
        false,
        Some("artifact-g"),
        Some("record-g"),
        false,
        0,
    );
    insert_calibration_check(
        &conn,
        "not-eligible",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "selected-by-candidate",
        130,
        2,
        "complete",
        false,
        Some("artifact-h"),
        Some("record-h"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "selected-by-candidate",
        "cargo-test",
        "pkg.alpha",
        true,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "not-reference-selected",
        120,
        2,
        "complete",
        false,
        Some("artifact-i"),
        Some("record-i"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "not-reference-selected",
        "cargo-test",
        "pkg.alpha",
        false,
        false,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "non-physical",
        110,
        2,
        "complete",
        false,
        Some("artifact-j"),
        Some("record-j"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "non-physical",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        false,
        "failed",
        "observed_shadow_miss",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "not-failed",
        100,
        2,
        "complete",
        false,
        Some("artifact-k"),
        Some("record-k"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "not-failed",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "passed",
        "observed_shadow_miss",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "wrong-signal",
        90,
        2,
        "complete",
        false,
        Some("artifact-l"),
        Some("record-l"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "wrong-signal",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "shadow_false_positive",
        true,
        50,
    );

    insert_calibration_run(
        &conn,
        "miss-flag-off",
        80,
        2,
        "complete",
        false,
        Some("artifact-m"),
        Some("record-m"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "miss-flag-off",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        false,
        50,
    );

    let policy = PromotionPolicy::default();
    let candidates = generate_candidates(&mut conn, &policy, 5_000).unwrap();
    assert_eq!(candidates.len(), 1);

    let candidate = &candidates[0];
    assert_eq!(candidate.trigger.scope, "pkg.alpha");
    assert_eq!(candidate.check_id, "cargo-test");
    assert_eq!(candidate.support_count, 2);
    assert_eq!(candidate.distinct_source_artifact_count, 2);
    assert_eq!(candidate.distinct_change_fingerprint_count, 2);
    assert_eq!(candidate.estimated_added_runtime_ms, 44);
    assert_eq!(candidate.state, PolicyState::Eligible);

    let evidence_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM policy_candidate_evidence WHERE candidate_id = ?1",
            params![candidate.candidate_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(evidence_count, 2);
}

#[test]
fn test_generate_candidates_lookback_limit_counts_calibration_runs_not_rows() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, 10).unwrap();

    insert_calibration_run(
        &conn,
        "newest-run",
        300,
        2,
        "complete",
        false,
        Some("artifact-newest"),
        Some("record-newest"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "newest-run",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        20,
    );
    insert_calibration_check(
        &conn,
        "newest-run",
        "cargo-clippy",
        "pkg.beta",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        25,
    );

    insert_calibration_run(
        &conn,
        "older-run",
        200,
        2,
        "complete",
        false,
        Some("artifact-older"),
        Some("record-older"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "older-run",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        30,
    );

    let policy = PromotionPolicy {
        lookback_limit: 1,
        min_observed_misses: 1,
        min_distinct_source_artifacts: 1,
        min_distinct_change_fingerprints: 1,
        ..PromotionPolicy::default()
    };
    let candidates = generate_candidates(&mut conn, &policy, 9_000).unwrap();

    assert_eq!(candidates.len(), 2);
    let scopes: Vec<_> = candidates
        .iter()
        .map(|candidate| candidate.trigger.scope.as_str())
        .collect();
    assert_eq!(scopes, vec!["pkg.alpha", "pkg.beta"]);
    assert!(candidates
        .iter()
        .all(|candidate| candidate.support_count == 1));

    let total_evidence: i64 = conn
        .query_row(
            "SELECT count(*) FROM policy_candidate_evidence",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(total_evidence, 2);
}

#[test]
fn test_candidate_read_apis_are_stable_and_fail_closed_on_unknown_state() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, 10).unwrap();

    insert_calibration_run(
        &conn,
        "candidate-read-a",
        200,
        2,
        "complete",
        false,
        Some("artifact-read-a"),
        Some("record-read-a"),
        true,
        0,
    );
    insert_calibration_check(
        &conn,
        "candidate-read-a",
        "cargo-test",
        "pkg.alpha",
        false,
        true,
        true,
        "failed",
        "observed_shadow_miss",
        true,
        10,
    );
    let policy = PromotionPolicy {
        min_observed_misses: 1,
        min_distinct_source_artifacts: 1,
        min_distinct_change_fingerprints: 1,
        ..PromotionPolicy::default()
    };
    let generated = generate_candidates(&mut conn, &policy, 2000).unwrap();
    let candidate_id = generated[0].candidate_id.clone();

    let listed = fdx::intelligence::policy::list_candidates(&conn, 10).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].candidate_id, candidate_id);
    assert_eq!(
        fdx::intelligence::policy::get_candidate(&conn, &candidate_id)
            .unwrap()
            .unwrap()
            .candidate_digest,
        generated[0].candidate_digest
    );
    assert!(fdx::intelligence::policy::get_candidate(&conn, "absent")
        .unwrap()
        .is_none());

    conn.execute(
        "UPDATE policy_candidates SET state = 'unsafe_unknown_state' WHERE candidate_id = ?1",
        params![candidate_id],
    )
    .unwrap();
    assert!(fdx::intelligence::policy::list_candidates(&conn, 10).is_err());
    assert!(fdx::intelligence::policy::get_candidate(&conn, &candidate_id).is_err());
}

#[test]
fn test_explicit_promotion_revalidates_evidence_and_revocation_is_idempotent() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, 10).unwrap();
    for (id, started, artifact, record) in [
        (
            "promotion-a",
            200,
            "artifact-promotion-a",
            "record-promotion-a",
        ),
        (
            "promotion-b",
            100,
            "artifact-promotion-b",
            "record-promotion-b",
        ),
    ] {
        insert_calibration_run(
            &conn,
            id,
            started,
            2,
            "complete",
            false,
            Some(artifact),
            Some(record),
            true,
            0,
        );
        insert_calibration_check(
            &conn,
            id,
            "cargo-test",
            "pkg.alpha",
            false,
            true,
            true,
            "failed",
            "observed_shadow_miss",
            true,
            20,
        );
    }
    let policy = PromotionPolicy::default();
    let candidate = generate_candidates(&mut conn, &policy, 1_000)
        .unwrap()
        .remove(0);

    let template =
        materialized_template("promotion-a", "artifact-promotion-a", "record-promotion-a");
    let promoted = promote_candidate_with_materialized_template(
        &mut conn,
        &candidate.candidate_id,
        &policy,
        &template,
        2_000,
    )
    .unwrap();
    assert_eq!(promoted.state, PolicyState::Promoted);
    assert_eq!(
        promote_candidate_with_materialized_template(
            &mut conn,
            &candidate.candidate_id,
            &policy,
            &template,
            3_000,
        )
        .unwrap()
        .policy_id,
        promoted.policy_id
    );
    let promotion_events: i64 = conn
        .query_row(
            "SELECT count(*) FROM policy_events WHERE policy_id = ?1 AND event_kind = 'promoted'",
            params![promoted.policy_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(promotion_events, 1);

    revoke_policy(&mut conn, &promoted.policy_id, "operator review", 4_000).unwrap();
    revoke_policy(&mut conn, &promoted.policy_id, "operator review", 5_000).unwrap();
    let (state, revoked_at): (String, Option<i64>) = conn
        .query_row(
            "SELECT state, revoked_at_ms FROM promoted_policies WHERE policy_id = ?1",
            params![promoted.policy_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "revoked");
    assert_eq!(revoked_at, Some(4_000));
    let revocation_events: i64 = conn
        .query_row(
            "SELECT count(*) FROM policy_events WHERE policy_id = ?1 AND event_kind = 'revoked'",
            params![promoted.policy_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(revocation_events, 1);
}

#[test]
fn test_promotion_persists_exact_template_and_active_overlay_loading_fails_closed_on_tamper() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, 10).unwrap();
    for (id, started, artifact, record) in [
        (
            "template-a",
            200,
            "artifact-template-a",
            "record-template-a",
        ),
        (
            "template-b",
            100,
            "artifact-template-b",
            "record-template-b",
        ),
    ] {
        insert_calibration_run(
            &conn,
            id,
            started,
            2,
            "complete",
            false,
            Some(artifact),
            Some(record),
            true,
            0,
        );
        insert_calibration_check(
            &conn,
            id,
            "cargo-test",
            "pkg.alpha",
            false,
            true,
            true,
            "failed",
            "observed_shadow_miss",
            true,
            20,
        );
    }
    let policy = PromotionPolicy::default();
    let candidate = generate_candidates(&mut conn, &policy, 1_000)
        .unwrap()
        .remove(0);
    let materialized =
        materialized_template("template-a", "artifact-template-a", "record-template-a");
    let expected_template_digest = compute_template_digest(&materialized.template.check).unwrap();
    let promoted = promote_candidate_with_materialized_template(
        &mut conn,
        &candidate.candidate_id,
        &policy,
        &materialized,
        2_000,
    )
    .unwrap();
    assert_eq!(promoted.template_digest, expected_template_digest);

    let snapshot = active_policy_snapshot(&conn).unwrap();
    assert_eq!(snapshot.policies, vec![promoted.clone()]);
    let templates = load_persisted_overlay_templates(&conn, &snapshot).unwrap();
    assert_eq!(
        templates.get(&promoted.template_digest),
        Some(&materialized.template.check)
    );
    let stored_json: String = conn
        .query_row(
            "SELECT planned_check_json FROM policy_check_templates WHERE template_digest = ?1",
            params![promoted.template_digest],
            |row| row.get(0),
        )
        .unwrap();
    assert!(stored_json.contains("learned_policy_add_check"));

    conn.execute(
        "UPDATE policy_check_templates SET planned_check_json = '{\"check_id\":\"tampered\"}' WHERE template_digest = ?1",
        params![promoted.template_digest],
    )
    .unwrap();
    assert!(load_persisted_overlay_templates(&conn, &snapshot).is_err());
}

#[test]
fn test_active_policy_snapshot_fails_closed_for_null_template_unknown_action_and_bad_provenance() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, 10).unwrap();
    for (id, started, artifact, record) in [
        (
            "snapshot-a",
            200,
            "artifact-snapshot-a",
            "record-snapshot-a",
        ),
        (
            "snapshot-b",
            100,
            "artifact-snapshot-b",
            "record-snapshot-b",
        ),
    ] {
        insert_calibration_run(
            &conn,
            id,
            started,
            2,
            "complete",
            false,
            Some(artifact),
            Some(record),
            true,
            0,
        );
        insert_calibration_check(
            &conn,
            id,
            "cargo-test",
            "pkg.alpha",
            false,
            true,
            true,
            "failed",
            "observed_shadow_miss",
            true,
            20,
        );
    }
    let policy = PromotionPolicy::default();
    let candidate = generate_candidates(&mut conn, &policy, 1_000)
        .unwrap()
        .remove(0);
    let materialized =
        materialized_template("snapshot-a", "artifact-snapshot-a", "record-snapshot-a");
    let promoted = promote_candidate_with_materialized_template(
        &mut conn,
        &candidate.candidate_id,
        &policy,
        &materialized,
        2_000,
    )
    .unwrap();

    conn.execute(
        "UPDATE promoted_policies SET template_digest = NULL WHERE policy_id = ?1",
        params![promoted.policy_id],
    )
    .unwrap();
    assert!(active_policy_snapshot(&conn).is_err());
    conn.execute(
        "UPDATE promoted_policies SET template_digest = ?2 WHERE policy_id = ?1",
        params![promoted.policy_id, promoted.template_digest],
    )
    .unwrap();
    conn.execute(
        "UPDATE promoted_policies SET action = 'remove_check' WHERE policy_id = ?1",
        params![promoted.policy_id],
    )
    .unwrap();
    assert!(active_policy_snapshot(&conn).is_err());
    conn.execute(
        "UPDATE promoted_policies SET action = 'add_check' WHERE policy_id = ?1",
        params![promoted.policy_id],
    )
    .unwrap();
    conn.execute(
        "UPDATE promoted_policies SET state = 'candidate' WHERE policy_id = ?1",
        params![promoted.policy_id],
    )
    .unwrap();
    assert!(active_policy_snapshot(&conn).is_err());
    conn.execute(
        "UPDATE promoted_policies SET state = 'promoted' WHERE policy_id = ?1",
        params![promoted.policy_id],
    )
    .unwrap();
    let snapshot = active_policy_snapshot(&conn).unwrap();
    conn.execute(
        "UPDATE policy_check_templates SET source_record_digest = 'not-qualified' WHERE template_digest = ?1",
        params![promoted.template_digest],
    )
    .unwrap();
    assert!(load_persisted_overlay_templates(&conn, &snapshot).is_err());
}

#[test]
fn test_promotion_fails_when_qualified_evidence_is_changed_after_candidate_generation() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, 10).unwrap();
    for (id, started, artifact, record) in [
        ("stale-a", 200, "artifact-stale-a", "record-stale-a"),
        ("stale-b", 100, "artifact-stale-b", "record-stale-b"),
    ] {
        insert_calibration_run(
            &conn,
            id,
            started,
            2,
            "complete",
            false,
            Some(artifact),
            Some(record),
            true,
            0,
        );
        insert_calibration_check(
            &conn,
            id,
            "cargo-test",
            "pkg.alpha",
            false,
            true,
            true,
            "failed",
            "observed_shadow_miss",
            true,
            20,
        );
    }
    let policy = PromotionPolicy::default();
    let candidate = generate_candidates(&mut conn, &policy, 1_000)
        .unwrap()
        .remove(0);
    conn.execute(
        "UPDATE calibration_metrics SET eligible_for_miss_rate = 0 WHERE calibration_id = 'stale-b'",
        [],
    )
    .unwrap();
    let template = materialized_template("stale-a", "artifact-stale-a", "record-stale-a");
    let error = promote_candidate_with_materialized_template(
        &mut conn,
        &candidate.candidate_id,
        &policy,
        &template,
        2_000,
    )
    .unwrap_err();
    assert!(error.contains("evidence no longer satisfies"));
    let count: i64 = conn
        .query_row("SELECT count(*) FROM promoted_policies", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn test_concurrent_template_bound_promotions_commit_one_policy_and_one_event() {
    use std::sync::{Arc, Barrier};
    use std::thread;

    let db_path = std::env::temp_dir().join(format!(
        "fdx-m11-policy-concurrency-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut setup = Connection::open(&db_path).unwrap();
    migrate_schema(&mut setup, 0, 10).unwrap();
    for (id, started, artifact, record) in [
        (
            "concurrency-a",
            200,
            "artifact-concurrency-a",
            "record-concurrency-a",
        ),
        (
            "concurrency-b",
            100,
            "artifact-concurrency-b",
            "record-concurrency-b",
        ),
    ] {
        insert_calibration_run(
            &setup,
            id,
            started,
            2,
            "complete",
            false,
            Some(artifact),
            Some(record),
            true,
            0,
        );
        insert_calibration_check(
            &setup,
            id,
            "cargo-test",
            "pkg.alpha",
            false,
            true,
            true,
            "failed",
            "observed_shadow_miss",
            true,
            20,
        );
    }
    let policy = PromotionPolicy::default();
    let candidate = generate_candidates(&mut setup, &policy, 1_000)
        .unwrap()
        .remove(0);
    let candidate_id = candidate.candidate_id;
    let template = materialized_template(
        "concurrency-a",
        "artifact-concurrency-a",
        "record-concurrency-a",
    );
    drop(setup);

    let workers = 20;
    let barrier = Arc::new(Barrier::new(workers));
    let mut handles = Vec::new();
    for worker in 0..workers {
        let barrier = Arc::clone(&barrier);
        let db_path = db_path.clone();
        let candidate_id = candidate_id.clone();
        let policy = policy.clone();
        let template = template.clone();
        handles.push(thread::spawn(move || {
            let mut conn = Connection::open(db_path).unwrap();
            barrier.wait();
            promote_candidate_with_materialized_template(
                &mut conn,
                &candidate_id,
                &policy,
                &template,
                2_000 + worker as u64,
            )
        }));
    }
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.len(), workers);
    assert!(results
        .iter()
        .all(|item| item.policy_id == results[0].policy_id));

    let conn = Connection::open(&db_path).unwrap();
    let policy_count: i64 = conn
        .query_row("SELECT count(*) FROM promoted_policies", [], |row| {
            row.get(0)
        })
        .unwrap();
    let event_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM policy_events WHERE event_kind = 'promoted'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let template_count: i64 = conn
        .query_row("SELECT count(*) FROM policy_check_templates", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(policy_count, 1);
    assert_eq!(event_count, 1);
    assert_eq!(template_count, 1);
    std::fs::remove_file(db_path).unwrap();
}

#[test]
fn test_promotion_enforces_per_trigger_additive_cap_without_mutating_second_candidate() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, 10).unwrap();
    for (id, started, artifact, record) in [
        ("cap-a", 200, "artifact-cap-a", "record-cap-a"),
        ("cap-b", 100, "artifact-cap-b", "record-cap-b"),
    ] {
        insert_calibration_run(
            &conn,
            id,
            started,
            2,
            "complete",
            false,
            Some(artifact),
            Some(record),
            true,
            0,
        );
        for check_id in ["cargo-test", "cargo-test-extra"] {
            insert_calibration_check(
                &conn,
                id,
                check_id,
                "pkg.alpha",
                false,
                true,
                true,
                "failed",
                "observed_shadow_miss",
                true,
                20,
            );
        }
    }
    let policy = PromotionPolicy::default();
    let candidates = generate_candidates(&mut conn, &policy, 1_000).unwrap();
    assert_eq!(candidates.len(), 2);
    let first = candidates
        .iter()
        .find(|candidate| candidate.check_id == "cargo-test")
        .unwrap();
    let second = candidates
        .iter()
        .find(|candidate| candidate.check_id == "cargo-test-extra")
        .unwrap();
    promote_candidate_with_materialized_template(
        &mut conn,
        &first.candidate_id,
        &policy,
        &materialized_template_for("cargo-test", "cap-a", "artifact-cap-a", "record-cap-a"),
        2_000,
    )
    .unwrap();
    let error = promote_candidate_with_materialized_template(
        &mut conn,
        &second.candidate_id,
        &policy,
        &materialized_template_for(
            "cargo-test-extra",
            "cap-a",
            "artifact-cap-a",
            "record-cap-a",
        ),
        3_000,
    )
    .unwrap_err();
    assert!(error.contains("additive check cap"));
    let second_state: String = conn
        .query_row(
            "SELECT state FROM policy_candidates WHERE candidate_id = ?1",
            params![second.candidate_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(second_state, "eligible");
    let promoted_count: i64 = conn
        .query_row("SELECT count(*) FROM promoted_policies", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(promoted_count, 1);
}
