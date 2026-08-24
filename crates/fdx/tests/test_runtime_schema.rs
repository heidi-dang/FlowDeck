use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::schema::CURRENT_SCHEMA_VERSION;
use tempfile::tempdir;

#[test]
fn test_runtime_schema_tables_survive_the_additive_v9_target() {
    assert_eq!(CURRENT_SCHEMA_VERSION, 9);

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
        assert_eq!(
            count, 1,
            "table {} does not exist in the current schema",
            table
        );
    }

    // Verify v7 columns exist
    let contract_col: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('runtime_runs') WHERE name = 'ingestion_contract_version'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        contract_col, 1,
        "ingestion_contract_version column exists in runtime_runs"
    );

    let physical_col: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('runtime_check_observations') WHERE name = 'has_physical_execution'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        physical_col, 1,
        "has_physical_execution column exists in runtime_check_observations"
    );
}
