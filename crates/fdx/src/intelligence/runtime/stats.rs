//! Historical descriptive statistics, duration percentiles, and flakiness signals for checks.

use crate::intelligence::runtime::model::{CheckHistoryStats, HistoricalFlakeSignal};
use rusqlite::{params, Connection};

/// Compute deterministic median and p95 percentiles over sorted samples.
pub fn compute_percentiles(sorted: &[u64]) -> (Option<f64>, Option<f64>) {
    if sorted.is_empty() {
        return (None, None);
    }
    let count = sorted.len();
    let median = if count % 2 == 1 {
        sorted[count / 2] as f64
    } else {
        (sorted[count / 2 - 1] as f64 + sorted[count / 2] as f64) / 2.0
    };

    // Deterministic nearest-rank p95
    let p95_idx = ((count as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(count - 1);
    let p95 = sorted[p95_idx] as f64;

    (Some(median), Some(p95))
}

/// Query historical descriptive statistics for a specific check ID.
pub fn query_check_statistics(
    conn: &Connection,
    check_id: &str,
) -> Result<Option<CheckHistoryStats>, String> {
    // 1. Fetch observation counts
    let mut stmt = conn
        .prepare(
            r#"
            SELECT c.run_id, c.execution_id, c.status, e.duration_ms, r.executed_at_ms
            FROM runtime_check_observations c
            JOIN runtime_runs r ON c.run_id = r.run_id
            LEFT JOIN runtime_executions e ON c.run_id = e.run_id AND c.execution_id = e.execution_id
            WHERE c.check_id = ?1
            ORDER BY r.executed_at_ms ASC, c.run_id ASC
            "#,
        )
        .map_err(|e| format!("prepare error: {}", e))?;

    let rows = stmt
        .query_map(params![check_id], |row| {
            let status_str: String = row.get(2)?;
            let duration_ms: Option<i64> = row.get(3)?;
            let executed_at_ms: i64 = row.get(4)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                status_str,
                duration_ms.map(|d| d as u64),
                executed_at_ms as u64,
            ))
        })
        .map_err(|e| format!("query error: {}", e))?;

    let mut total_observations = 0u64;
    let mut unique_executions_set = std::collections::HashSet::new();
    let mut pass_count = 0u64;
    let mut real_failure_count = 0u64;
    let mut incomplete_count = 0u64;
    let mut last_observed_at_ms: Option<u64> = None;
    let mut last_passed_at_ms: Option<u64> = None;
    let mut durations = Vec::new();

    // For flake signal: track transitions and statuses across time
    let mut prev_status: Option<String> = None;
    let mut transitions = 0u64;

    for r in rows {
        let (run_id, execution_id, status_str, duration_opt, executed_at_ms) =
            r.map_err(|e| format!("row error: {}", e))?;

        total_observations += 1;
        unique_executions_set.insert((run_id, execution_id));
        last_observed_at_ms = Some(executed_at_ms);

        match status_str.as_str() {
            "passed" => {
                pass_count += 1;
                last_passed_at_ms = Some(executed_at_ms);
            }
            "failed" => {
                real_failure_count += 1;
            }
            _ => {
                incomplete_count += 1;
            }
        }

        if let Some(prev) = &prev_status {
            if prev != &status_str {
                transitions += 1;
            }
        }
        prev_status = Some(status_str);

        if let Some(dur) = duration_opt {
            durations.push(dur);
        }
    }

    if total_observations == 0 {
        return Ok(None);
    }

    durations.sort_unstable();
    let min_duration_ms = durations.first().copied();
    let max_duration_ms = durations.last().copied();
    let (median_duration_ms, p95_duration_ms) = compute_percentiles(&durations);

    let flake_signal = HistoricalFlakeSignal {
        observed_passes: pass_count,
        observed_failures: real_failure_count,
        incomplete_observations: incomplete_count,
        transition_count: transitions,
        is_flake_signal_present: pass_count > 0 && real_failure_count > 0,
    };

    Ok(Some(CheckHistoryStats {
        check_id: check_id.to_string(),
        total_observations,
        unique_executions: unique_executions_set.len() as u64,
        pass_count,
        real_failure_count,
        incomplete_count,
        last_observed_at_ms,
        last_passed_at_ms,
        min_duration_ms,
        max_duration_ms,
        median_duration_ms,
        p95_duration_ms,
        flake_signal,
    }))
}
