use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::schema::CURRENT_SCHEMA_VERSION;
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn test_v6_to_v7_migration_and_legacy_unqualified_rows() {
    assert_eq!(CURRENT_SCHEMA_VERSION, 10);

    let dir = tempdir().unwrap();
    let db_path = dir.path().join(".fdx").join("index.sqlite");
    std::fs::create_dir_all(dir.path().join(".fdx")).unwrap();

    // 1. Manually create a schema v6 database and insert a v6 legacy row
    {
        let mut conn = Connection::open(&db_path).unwrap();
        // Run migration 0 to 6
        fdx::intelligence::migration::migrate_schema(&mut conn, 0, 6).unwrap();

        // Insert a legacy row in runtime_runs without ingestion_contract_version
        conn.execute(
            r#"
            INSERT INTO runtime_runs (
                run_id, artifact_digest, plan_digest, outcome, assurance,
                executed_at_ms, duration_ms, base_ref, head_ref, imported_at_ms
            ) VALUES ('legacy_run_1', 'old_digest', 'plan_dig', 'passed', 'exact', 1000, 50, NULL, NULL, 1000)
            "#,
            [],
        )
        .unwrap();

        // Insert a fake runtime execution with synthetic id (v6 bug)
        conn.execute(
            r#"
            INSERT INTO runtime_executions (
                run_id, execution_id, program, argv_digest, cwd,
                status, exit_code, duration_ms, stdout_digest, stderr_digest,
                stdout_captured_bytes, stderr_captured_bytes, output_truncated
            ) VALUES ('legacy_run_1', 'unsupported:check_x', 'unknown', 'argv', '.', 'unsupported', NULL, 0, NULL, NULL, 0, 0, 0)
            "#,
            [],
        )
        .unwrap();
    }

    // 2. Open via EvidenceDatabase to trigger the frozen v7 migration and later additive migrations
    {
        let db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

        // Check user_version reaches the current additive schema target
        let version: u32 = db
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 10);

        // Check that legacy_run_1 has ingestion_contract_version = 1 (legacy / unqualified)
        let contract_version: i64 = db
            .conn
            .query_row(
                "SELECT ingestion_contract_version FROM runtime_runs WHERE run_id = 'legacy_run_1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(contract_version, 1);
    }
}
