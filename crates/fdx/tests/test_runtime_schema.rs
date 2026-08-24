use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::schema::CURRENT_SCHEMA_VERSION;
use tempfile::tempdir;

#[test]
fn test_runtime_schema_version_is_6_and_tables_exist() {
    assert_eq!(CURRENT_SCHEMA_VERSION, 6);

    let dir = tempdir().unwrap();
    let db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();

    // Verify tables exist
    let tables = [
        "runtime_runs",
        "runtime_executions",
        "runtime_check_observations",
        "runtime_change_observations",
        "runtime_ingestion_state",
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
        assert_eq!(count, 1, "table {} does not exist in schema v6", table);
    }
}
