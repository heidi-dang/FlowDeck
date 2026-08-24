//! Changed entity co-occurrence observations during historical verification runs.
//!
//! Explicitly distinct from semantic coverage/dependency edges.

use rusqlite::{params, Connection};

/// Observation of a changed entity co-occurring with a verification check.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CoOccurrenceObservation {
    pub entity_id: String,
    pub entity_kind: String,
    pub run_count: u64,
    pub last_observed_at_ms: u64,
}

/// Query changed entities that co-occurred in historical runs with a specific check.
pub fn query_check_cooccurrences(
    conn: &Connection,
    check_id: &str,
) -> Result<Vec<CoOccurrenceObservation>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT ch.entity_id, ch.entity_kind, COUNT(DISTINCT ch.run_id) as run_cnt, MAX(r.executed_at_ms) as last_seen
            FROM runtime_change_observations ch
            JOIN runtime_check_observations c ON ch.run_id = c.run_id
            JOIN runtime_runs r ON ch.run_id = r.run_id
            WHERE c.check_id = ?1
            GROUP BY ch.entity_id, ch.entity_kind
            ORDER BY run_cnt DESC, ch.entity_id ASC
            "#,
        )
        .map_err(|e| format!("prepare error: {}", e))?;

    let rows = stmt
        .query_map(params![check_id], |row| {
            let run_cnt: i64 = row.get(2)?;
            let last_seen: i64 = row.get(3)?;
            Ok(CoOccurrenceObservation {
                entity_id: row.get(0)?,
                entity_kind: row.get(1)?,
                run_count: run_cnt as u64,
                last_observed_at_ms: last_seen as u64,
            })
        })
        .map_err(|e| format!("query error: {}", e))?;

    let mut results = Vec::new();
    for r in rows {
        results.push(r.map_err(|e| format!("row error: {}", e))?);
    }

    Ok(results)
}
