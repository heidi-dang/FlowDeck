use fdx::intelligence::calibration::{
    get_calibration_run, get_calibration_stats, list_calibration_runs,
};
use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn test_v8_calibration_rows_remain_legacy_and_excluded_from_qualified_aggregates() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join(".fdx").join("index.sqlite");
    std::fs::create_dir_all(dir.path().join(".fdx")).unwrap();

    {
        let mut conn = Connection::open(&db_path).unwrap();
        fdx::intelligence::migration::migrate_schema(&mut conn, 0, 8).unwrap();
        conn.execute(
            r#"
            INSERT INTO calibration_runs (
                calibration_id, source_run_id, candidate_plan_digest, policy_digest, status,
                reference_scope, max_shadow_checks, reference_truncated, started_at_ms,
                completed_at_ms, duration_ms, created_at_ms
            ) VALUES ('legacy-calibration', 'legacy-run', 'plan', 'policy', 'complete',
                      'affected', 5, 0, 1, 2, 1, 2)
            "#,
            [],
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO calibration_metrics (
                calibration_id, candidate_selected_count, shadow_reference_count,
                shadow_executed_count, selected_failure_count, unselected_failure_count,
                observed_shadow_miss_count, shadow_incomplete_count,
                candidate_execution_duration_ms, shadow_reference_duration_ms,
                selection_ratio, runtime_cost_ratio, signal_recall,
                eligible_for_miss_rate, eligible_for_cost_ratio, eligible_for_runtime_comparison
            ) VALUES ('legacy-calibration', 1, 2, 2, 1, 1, 1, 0, 10, 20,
                      0.5, 0.5, 0.5, 1, 1, 1)
            "#,
            [],
        )
        .unwrap();
    }

    let db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();
    let version: u32 = db
        .conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 10);

    let (contract_version, record_digest): (i64, Option<String>) = db
        .conn
        .query_row(
            "SELECT calibration_contract_version, record_digest FROM calibration_runs WHERE calibration_id = 'legacy-calibration'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(contract_version, 1);
    assert_eq!(record_digest, None);

    let listed = list_calibration_runs(&db.conn, 10).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].calibration_contract_version, 1);
    assert_eq!(listed[0].record_digest, None);
    assert!(get_calibration_run(&db.conn, "legacy-calibration").is_err());

    // A complete qualified v9 record is eligible, while an incomplete v9 record with
    // descriptive partial recall is deliberately ineligible for accuracy aggregation.
    for (id, status, recall, eligible) in [
        ("qualified-complete", "complete", 0.5_f64, true),
        ("qualified-incomplete", "incomplete", 0.2_f64, false),
    ] {
        db.conn
            .execute(
                r#"
            INSERT INTO calibration_runs (
                calibration_id, source_run_id, candidate_plan_digest, policy_digest, status,
                reference_scope, max_shadow_checks, reference_truncated, started_at_ms,
                completed_at_ms, duration_ms, created_at_ms, calibration_contract_version,
                source_artifact_sha256, record_digest, max_total_duration_ms,
                per_check_timeout_ms, max_output_bytes
            ) VALUES (?1, ?1, 'plan', 'policy', ?2, 'affected', 5, 0, 3, 4, 1, 4,
                      2, 'source-sha', ?1, 100, 50, 1024)
            "#,
                rusqlite::params![id, status],
            )
            .unwrap();
        db.conn
            .execute(
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
            ) VALUES (?1, 1, 2, 1, 1, 1, 1, 1, 1, 0, 10, 20,
                      0.5, 0.5, ?2, ?3, ?3, ?3)
            "#,
                rusqlite::params![id, recall, eligible],
            )
            .unwrap();
    }

    let stats = get_calibration_stats(&db.conn).unwrap();
    assert_eq!(stats.total_calibrations, 3);
    assert_eq!(stats.mean_signal_recall, Some(0.5));
    assert_eq!(stats.mean_runtime_cost_ratio, Some(0.5));
}
