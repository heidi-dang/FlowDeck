use fdx::intelligence::migration::migrate_schema;
use fdx::intelligence::schema::CURRENT_SCHEMA_VERSION;
use rusqlite::Connection;

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [name],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn test_policy_schema_v10_current_contains_additive_policy_tables() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, CURRENT_SCHEMA_VERSION).unwrap();
    assert_eq!(CURRENT_SCHEMA_VERSION, 10);
    for table in [
        "policy_candidates",
        "policy_candidate_evidence",
        "policy_check_templates",
        "promoted_policies",
        "policy_events",
        "policy_applications",
    ] {
        assert!(table_exists(&conn, table), "missing table {table}");
    }
}

#[test]
fn test_v9_to_v10_migration_is_additive_and_preserves_calibration_schema() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate_schema(&mut conn, 0, 9).unwrap();
    assert!(table_exists(&conn, "calibration_runs"));
    migrate_schema(&mut conn, 9, 10).unwrap();
    assert!(table_exists(&conn, "calibration_runs"));
    assert!(table_exists(&conn, "policy_candidates"));
    assert!(table_exists(&conn, "policy_check_templates"));
    let version: u32 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 10);
}
