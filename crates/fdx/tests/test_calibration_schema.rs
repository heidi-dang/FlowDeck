use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::schema::CURRENT_SCHEMA_VERSION;
use rusqlite::Connection;
use tempfile::tempdir;

#[test]
fn test_calibration_schema_tables_and_columns_exist() {
    assert_eq!(CURRENT_SCHEMA_VERSION, 10);

    let dir = tempdir().unwrap();
    let db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    let tables = [
        "calibration_runs",
        "calibration_checks",
        "calibration_executions",
        "calibration_metrics",
    ];

    for table in tables {
        let count: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                rusqlite::params![table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "table {} does not exist in schema v9", table);
    }
}

#[test]
fn test_v7_to_v9_migration_preserves_data() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join(".fdx").join("index.sqlite");
    std::fs::create_dir_all(dir.path().join(".fdx")).unwrap();

    // 1. Create a schema v7 database
    {
        let mut conn = Connection::open(&db_path).unwrap();
        fdx::intelligence::migration::migrate_schema(&mut conn, 0, 7).unwrap();

        // Insert a v7 runtime run
        conn.execute(
            r#"
            INSERT INTO runtime_runs (
                run_id, artifact_digest, plan_digest, outcome, assurance,
                executed_at_ms, duration_ms, base_ref, head_ref, imported_at_ms,
                ingestion_contract_version
            ) VALUES ('test_run_v7', 'art_dig', 'plan_dig', 'passed', 'exact', 1000, 50, NULL, NULL, 1000, 2)
            "#,
            [],
        )
        .unwrap();
    }

    // 2. Open via EvidenceDatabase to trigger the additive v8–v10 migrations
    {
        let db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

        let version: u32 = db
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 10);

        // Check runtime_runs row is intact
        let run_count: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM runtime_runs WHERE run_id = 'test_run_v7'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(run_count, 1);
    }
}
