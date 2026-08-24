//! Read-only queries over historical shadow calibration runs and metrics.

use crate::intelligence::calibration::model::*;
use crate::intelligence::testplan::model::VerificationCheckKind;
use crate::intelligence::verify::model::CheckExecutionStatus;
use rusqlite::{params, Connection, OptionalExtension};

/// List historical shadow calibration runs ordered by start time descending.
pub fn list_calibration_runs(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<CalibrationRunSummary>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT r.calibration_id, r.source_run_id, r.candidate_plan_digest,
                   r.policy_digest, r.status, r.reference_scope,
                   m.candidate_selected_count, m.shadow_reference_count,
                   m.observed_shadow_miss_count, m.signal_recall,
                   r.started_at_ms, r.duration_ms
            FROM calibration_runs r
            LEFT JOIN calibration_metrics m ON r.calibration_id = m.calibration_id
            ORDER BY r.started_at_ms DESC, r.calibration_id DESC
            LIMIT ?1
            "#,
        )
        .map_err(|e| format!("failed to prepare list statement: {}", e))?;

    let rows = stmt
        .query_map(params![limit as i64], |row| {
            let status_str: String = row.get(4)?;
            let status = match status_str.as_str() {
                "complete" => CalibrationStatus::Complete,
                "incomplete" => CalibrationStatus::Incomplete,
                _ => CalibrationStatus::Failed,
            };

            let started_at_ms: i64 = row.get(10)?;
            let duration_ms: i64 = row.get(11)?;

            Ok(CalibrationRunSummary {
                calibration_id: row.get(0)?,
                source_run_id: row.get(1)?,
                candidate_plan_digest: row.get(2)?,
                policy_digest: row.get(3)?,
                status,
                reference_scope: row.get(5)?,
                candidate_selected_count: row.get::<_, Option<i64>>(6)?.unwrap_or(0) as usize,
                shadow_reference_count: row.get::<_, Option<i64>>(7)?.unwrap_or(0) as usize,
                observed_shadow_miss_count: row.get::<_, Option<i64>>(8)?.unwrap_or(0) as usize,
                signal_recall: row.get(9)?,
                started_at_ms: started_at_ms as u64,
                duration_ms: duration_ms as u64,
            })
        })
        .map_err(|e| format!("failed to query calibration runs: {}", e))?;

    let mut summaries = Vec::new();
    for r in rows {
        summaries.push(r.map_err(|e| format!("row error: {}", e))?);
    }
    Ok(summaries)
}

pub type CalibrationRunDetail = (
    CalibrationRunSummary,
    CalibrationMetrics,
    Vec<ShadowCheckObservation>,
    Vec<ShadowExecutionObservation>,
);

/// Retrieve details for a specific calibration run ID.
pub fn get_calibration_run(
    conn: &Connection,
    calibration_id: &str,
) -> Result<Option<CalibrationRunDetail>, String> {
    let run_summary: Option<CalibrationRunSummary> = conn
        .query_row(
            r#"
            SELECT r.calibration_id, r.source_run_id, r.candidate_plan_digest,
                   r.policy_digest, r.status, r.reference_scope,
                   m.candidate_selected_count, m.shadow_reference_count,
                   m.observed_shadow_miss_count, m.signal_recall,
                   r.started_at_ms, r.duration_ms
            FROM calibration_runs r
            LEFT JOIN calibration_metrics m ON r.calibration_id = m.calibration_id
            WHERE r.calibration_id = ?1
            "#,
            params![calibration_id],
            |row| {
                let status_str: String = row.get(4)?;
                let status = match status_str.as_str() {
                    "complete" => CalibrationStatus::Complete,
                    "incomplete" => CalibrationStatus::Incomplete,
                    _ => CalibrationStatus::Failed,
                };
                let started_at_ms: i64 = row.get(10)?;
                let duration_ms: i64 = row.get(11)?;
                Ok(CalibrationRunSummary {
                    calibration_id: row.get(0)?,
                    source_run_id: row.get(1)?,
                    candidate_plan_digest: row.get(2)?,
                    policy_digest: row.get(3)?,
                    status,
                    reference_scope: row.get(5)?,
                    candidate_selected_count: row.get::<_, Option<i64>>(6)?.unwrap_or(0) as usize,
                    shadow_reference_count: row.get::<_, Option<i64>>(7)?.unwrap_or(0) as usize,
                    observed_shadow_miss_count: row.get::<_, Option<i64>>(8)?.unwrap_or(0) as usize,
                    signal_recall: row.get(9)?,
                    started_at_ms: started_at_ms as u64,
                    duration_ms: duration_ms as u64,
                })
            },
        )
        .optional()
        .map_err(|e| format!("failed to query calibration summary: {}", e))?;

    let summary = match run_summary {
        Some(s) => s,
        None => return Ok(None),
    };

    // Query metrics
    let metrics: CalibrationMetrics = conn
        .query_row(
            r#"
            SELECT candidate_selected_count, shadow_reference_count, shadow_executed_count,
                   selected_failure_count, unselected_failure_count, observed_shadow_miss_count,
                   shadow_incomplete_count, candidate_execution_duration_ms, shadow_reference_duration_ms,
                   selection_ratio, runtime_cost_ratio, signal_recall,
                   eligible_for_miss_rate, eligible_for_cost_ratio, eligible_for_runtime_comparison
            FROM calibration_metrics
            WHERE calibration_id = ?1
            "#,
            params![calibration_id],
            |row| {
                let cand_dur: i64 = row.get(7)?;
                let shad_dur: i64 = row.get(8)?;
                Ok(CalibrationMetrics {
                    candidate_selected_count: row.get::<_, i64>(0)? as usize,
                    shadow_reference_count: row.get::<_, i64>(1)? as usize,
                    shadow_executed_count: row.get::<_, i64>(2)? as usize,
                    selected_failure_count: row.get::<_, i64>(3)? as usize,
                    unselected_failure_count: row.get::<_, i64>(4)? as usize,
                    observed_shadow_miss_count: row.get::<_, i64>(5)? as usize,
                    shadow_incomplete_count: row.get::<_, i64>(6)? as usize,
                    candidate_execution_duration_ms: cand_dur as u64,
                    shadow_reference_duration_ms: shad_dur as u64,
                    selection_ratio: row.get(9)?,
                    runtime_cost_ratio: row.get(10)?,
                    signal_recall: row.get(11)?,
                    eligibility: CalibrationEligibility {
                        eligible_for_miss_rate: row.get(12)?,
                        eligible_for_cost_ratio: row.get(13)?,
                        eligible_for_runtime_comparison: row.get(14)?,
                    },
                })
            },
        )
        .map_err(|e| format!("failed to query calibration metrics: {}", e))?;

    // Query checks
    let mut check_stmt = conn
        .prepare(
            r#"
            SELECT check_id, candidate_selected, reference_selected, execution_status,
                   has_physical_execution, duration_ms, signal_class, is_observed_shadow_miss, reason
            FROM calibration_checks
            WHERE calibration_id = ?1
            ORDER BY check_id ASC
            "#,
        )
        .map_err(|e| format!("failed to prepare checks query: {}", e))?;

    let check_rows = check_stmt
        .query_map(params![calibration_id], |row| {
            let check_id: String = row.get(0)?;
            let status_str: String = row.get(3)?;
            let formatted_status = format!(r#""{}""#, status_str);
            let exec_status: CheckExecutionStatus = serde_json::from_str(&formatted_status)
                .unwrap_or(CheckExecutionStatus::Unsupported);
            let dur: i64 = row.get(5)?;
            let sig_str: String = row.get(6)?;
            let signal_class = match sig_str.as_str() {
                "selected_signal" => SignalClass::SelectedSignal,
                "observed_shadow_miss" => SignalClass::ObservedShadowMiss,
                "selected_pass" => SignalClass::SelectedPass,
                "unselected_pass" => SignalClass::UnselectedPass,
                _ => SignalClass::Incomplete,
            };

            let kind = if check_id.starts_with("test:") {
                VerificationCheckKind::UnitTest
            } else {
                VerificationCheckKind::Custom
            };

            Ok(ShadowCheckObservation {
                check_id: check_id.clone(),
                display_name: check_id,
                kind,
                scope: "repo".to_string(),
                candidate_selected: row.get(1)?,
                reference_selected: row.get(2)?,
                execution_status: exec_status,
                has_physical_execution: row.get(4)?,
                duration_ms: dur as u64,
                signal_class,
                is_observed_shadow_miss: row.get(7)?,
                reason: row.get(8)?,
            })
        })
        .map_err(|e| format!("failed to query checks: {}", e))?;

    let mut checks = Vec::new();
    for c in check_rows {
        checks.push(c.map_err(|e| format!("check row error: {}", e))?);
    }

    // Query executions
    let mut exec_stmt = conn
        .prepare(
            r#"
            SELECT execution_id, check_id, program, argv_digest, cwd, status,
                   exit_code, duration_ms, stdout_digest, stderr_digest
            FROM calibration_executions
            WHERE calibration_id = ?1
            ORDER BY execution_id ASC
            "#,
        )
        .map_err(|e| format!("failed to prepare executions query: {}", e))?;

    let exec_rows = exec_stmt
        .query_map(params![calibration_id], |row| {
            let status_str: String = row.get(5)?;
            let formatted_status = format!(r#""{}""#, status_str);
            let exec_status: CheckExecutionStatus = serde_json::from_str(&formatted_status)
                .unwrap_or(CheckExecutionStatus::Unsupported);
            let dur: i64 = row.get(7)?;

            Ok(ShadowExecutionObservation {
                execution_id: row.get(0)?,
                check_id: row.get(1)?,
                program: row.get(2)?,
                argv_digest: row.get(3)?,
                cwd: row.get(4)?,
                status: exec_status,
                exit_code: row.get(6)?,
                duration_ms: dur as u64,
                stdout_digest: row.get(8)?,
                stderr_digest: row.get(9)?,
            })
        })
        .map_err(|e| format!("failed to query executions: {}", e))?;

    let mut executions = Vec::new();
    for ex in exec_rows {
        executions.push(ex.map_err(|e| format!("execution row error: {}", e))?);
    }

    Ok(Some((summary, metrics, checks, executions)))
}

/// Aggregate statistics across completed calibration runs in history.
pub fn get_calibration_stats(conn: &Connection) -> Result<CalibrationAggregateStats, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT r.status, m.candidate_selected_count, m.shadow_reference_count,
                   m.observed_shadow_miss_count, m.selection_ratio, m.runtime_cost_ratio,
                   m.signal_recall
            FROM calibration_runs r
            LEFT JOIN calibration_metrics m ON r.calibration_id = m.calibration_id
            "#,
        )
        .map_err(|e| format!("failed to prepare stats query: {}", e))?;

    let mut total_calibrations = 0;
    let mut complete_calibrations = 0;
    let mut incomplete_calibrations = 0;
    let mut total_candidate_checks = 0;
    let mut total_shadow_checks = 0;
    let mut total_observed_misses = 0;

    let mut selection_ratios: Vec<f64> = Vec::new();
    let mut cost_ratios: Vec<f64> = Vec::new();
    let mut signal_recalls: Vec<f64> = Vec::new();

    let rows = stmt
        .query_map([], |row| {
            let status_str: String = row.get(0)?;
            let cand_cnt: Option<i64> = row.get(1)?;
            let shad_cnt: Option<i64> = row.get(2)?;
            let miss_cnt: Option<i64> = row.get(3)?;
            let sel_ratio: Option<f64> = row.get(4)?;
            let cost_ratio: Option<f64> = row.get(5)?;
            let recall: Option<f64> = row.get(6)?;

            Ok((
                status_str, cand_cnt, shad_cnt, miss_cnt, sel_ratio, cost_ratio, recall,
            ))
        })
        .map_err(|e| format!("query error: {}", e))?;

    for r in rows {
        let (status_str, cand_cnt, shad_cnt, miss_cnt, sel_ratio, cost_ratio, recall) =
            r.map_err(|e| format!("row error: {}", e))?;

        total_calibrations += 1;
        if status_str == "complete" {
            complete_calibrations += 1;
        } else {
            incomplete_calibrations += 1;
        }

        if let Some(c) = cand_cnt {
            total_candidate_checks += c as usize;
        }
        if let Some(s) = shad_cnt {
            total_shadow_checks += s as usize;
        }
        if let Some(m) = miss_cnt {
            total_observed_misses += m as usize;
        }
        if let Some(sr) = sel_ratio {
            selection_ratios.push(sr);
        }
        if let Some(cr) = cost_ratio {
            cost_ratios.push(cr);
        }
        if let Some(rc) = recall {
            signal_recalls.push(rc);
        }
    }

    let mean_selection_ratio = if !selection_ratios.is_empty() {
        Some(selection_ratios.iter().sum::<f64>() / selection_ratios.len() as f64)
    } else {
        None
    };

    let mean_runtime_cost_ratio = if !cost_ratios.is_empty() {
        Some(cost_ratios.iter().sum::<f64>() / cost_ratios.len() as f64)
    } else {
        None
    };

    let mean_signal_recall = if !signal_recalls.is_empty() {
        Some(signal_recalls.iter().sum::<f64>() / signal_recalls.len() as f64)
    } else {
        None
    };

    Ok(CalibrationAggregateStats {
        total_calibrations,
        complete_calibrations,
        incomplete_calibrations,
        total_candidate_checks,
        total_shadow_checks,
        total_observed_misses,
        mean_selection_ratio,
        mean_runtime_cost_ratio,
        mean_signal_recall,
    })
}
