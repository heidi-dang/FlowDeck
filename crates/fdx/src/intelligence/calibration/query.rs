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
    let mut statement = conn
        .prepare(
            r#"
            SELECT r.calibration_id, r.calibration_contract_version, r.source_run_id,
                   r.source_artifact_sha256, r.candidate_plan_digest, r.policy_digest,
                   r.record_digest, r.status, r.reference_scope,
                   m.candidate_selected_count, m.shadow_reference_count,
                   m.observed_shadow_miss_count, m.signal_recall, r.started_at_ms,
                   r.duration_ms
            FROM calibration_runs r
            LEFT JOIN calibration_metrics m ON r.calibration_id = m.calibration_id
            ORDER BY r.started_at_ms DESC, r.calibration_id DESC
            LIMIT ?1
            "#,
        )
        .map_err(|error| format!("failed to prepare calibration list query: {error}"))?;
    let rows = statement
        .query_map(params![limit as i64], summary_from_row)
        .map_err(|error| format!("failed to query calibration runs: {error}"))?;
    rows.map(|row| row.map_err(|error| format!("calibration list row error: {error}")))
        .collect()
}

pub type CalibrationRunDetail = (
    CalibrationRunSummary,
    CalibrationMetrics,
    Vec<ShadowCheckObservation>,
    Vec<ShadowExecutionObservation>,
);

/// Retrieve the exact qualified evidence for one calibration. Legacy v8 records remain listable
/// but cannot be reconstructed as qualified detail because their missing fields must not be guessed.
pub fn get_calibration_run(
    conn: &Connection,
    calibration_id: &str,
) -> Result<Option<CalibrationRunDetail>, String> {
    let summary: Option<CalibrationRunSummary> = conn
        .query_row(
            r#"
            SELECT r.calibration_id, r.calibration_contract_version, r.source_run_id,
                   r.source_artifact_sha256, r.candidate_plan_digest, r.policy_digest,
                   r.record_digest, r.status, r.reference_scope,
                   m.candidate_selected_count, m.shadow_reference_count,
                   m.observed_shadow_miss_count, m.signal_recall, r.started_at_ms,
                   r.duration_ms
            FROM calibration_runs r
            LEFT JOIN calibration_metrics m ON r.calibration_id = m.calibration_id
            WHERE r.calibration_id = ?1
            "#,
            params![calibration_id],
            summary_from_row,
        )
        .optional()
        .map_err(|error| format!("failed to query calibration summary: {error}"))?;
    let Some(summary) = summary else {
        return Ok(None);
    };
    if summary.calibration_contract_version != CALIBRATION_CONTRACT_VERSION {
        return Err(format!(
            "calibration '{}' is legacy/unqualified and cannot provide exact v2 evidence",
            calibration_id
        ));
    }

    let metrics = conn
        .query_row(
            r#"
            SELECT candidate_selected_count, shadow_reference_count, shadow_executed_count,
                   candidate_physical_execution_count, shadow_physical_execution_count,
                   selected_failure_count, unselected_failure_count, observed_shadow_miss_count,
                   shadow_incomplete_count, candidate_execution_duration_ms,
                   shadow_reference_duration_ms, selection_ratio, runtime_cost_ratio,
                   signal_recall, eligible_for_miss_rate, eligible_for_cost_ratio,
                   eligible_for_runtime_comparison
            FROM calibration_metrics WHERE calibration_id = ?1
            "#,
            params![calibration_id],
            |row| {
                Ok(CalibrationMetrics {
                    candidate_selected_count: as_usize_sql(row.get(0)?)?,
                    shadow_reference_count: as_usize_sql(row.get(1)?)?,
                    shadow_executed_count: as_usize_sql(row.get(2)?)?,
                    candidate_physical_execution_count: as_usize_sql(row.get(3)?)?,
                    shadow_physical_execution_count: as_usize_sql(row.get(4)?)?,
                    selected_failure_count: as_usize_sql(row.get(5)?)?,
                    unselected_failure_count: as_usize_sql(row.get(6)?)?,
                    observed_shadow_miss_count: as_usize_sql(row.get(7)?)?,
                    shadow_incomplete_count: as_usize_sql(row.get(8)?)?,
                    candidate_execution_duration_ms: as_u64_sql(row.get(9)?)?,
                    shadow_reference_duration_ms: as_u64_sql(row.get(10)?)?,
                    selection_ratio: row.get(11)?,
                    runtime_cost_ratio: row.get(12)?,
                    signal_recall: row.get(13)?,
                    eligibility: CalibrationEligibility {
                        eligible_for_miss_rate: row.get(14)?,
                        eligible_for_cost_ratio: row.get(15)?,
                        eligible_for_runtime_comparison: row.get(16)?,
                    },
                })
            },
        )
        .map_err(|error| format!("failed to query calibration metrics: {error}"))?;

    let mut check_statement = conn
        .prepare(
            r#"
            SELECT check_id, display_name, kind, scope, candidate_selected,
                   reference_selected, execution_status, has_physical_execution,
                   execution_id, reused_execution, duration_ms, signal_class,
                   is_observed_shadow_miss, reason
            FROM calibration_checks
            WHERE calibration_id = ?1
            ORDER BY check_id ASC
            "#,
        )
        .map_err(|error| format!("failed to prepare calibration checks query: {error}"))?;
    let checks = check_statement
        .query_map(params![calibration_id], |row| {
            let status: String = row.get(6)?;
            let kind: String = required_text(row.get(2)?, "kind")?;
            let signal_class: String = row.get(11)?;
            let physical: bool = row.get(7)?;
            let execution_id: Option<String> = row.get(8)?;
            if physical != execution_id.is_some() {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(ShadowCheckObservation {
                check_id: row.get(0)?,
                display_name: required_text(row.get(1)?, "display_name")?,
                kind: parse_kind(&kind).map_err(|_| rusqlite::Error::InvalidQuery)?,
                scope: required_text(row.get(3)?, "scope")?,
                candidate_selected: row.get(4)?,
                reference_selected: row.get(5)?,
                execution_status: parse_status(&status)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                has_physical_execution: physical,
                execution_id,
                reused_execution: row
                    .get::<_, Option<bool>>(9)?
                    .ok_or(rusqlite::Error::InvalidQuery)?,
                duration_ms: as_u64(row.get(10)?, "duration_ms")
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                signal_class: parse_signal_class(&signal_class)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                is_observed_shadow_miss: row.get(12)?,
                reason: row.get(13)?,
            })
        })
        .map_err(|error| format!("failed to query calibration checks: {error}"))?
        .map(|row| {
            row.map_err(|error| format!("invalid persisted calibration check evidence: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut execution_statement = conn
        .prepare(
            r#"
            SELECT execution_id, check_id, origin, program, argv_digest, cwd, status,
                   exit_code, duration_ms, stdout_digest, stderr_digest
            FROM calibration_executions
            WHERE calibration_id = ?1
            ORDER BY execution_id ASC
            "#,
        )
        .map_err(|error| format!("failed to prepare calibration executions query: {error}"))?;
    let executions = execution_statement
        .query_map(params![calibration_id], |row| {
            let origin: String = required_text(row.get(2)?, "origin")?;
            let status: String = row.get(6)?;
            Ok(ShadowExecutionObservation {
                execution_id: row.get(0)?,
                check_id: row.get(1)?,
                origin: parse_origin(&origin).map_err(|_| rusqlite::Error::InvalidQuery)?,
                program: row.get(3)?,
                argv_digest: row.get(4)?,
                cwd: row.get(5)?,
                status: parse_status(&status).map_err(|_| rusqlite::Error::InvalidQuery)?,
                exit_code: row.get(7)?,
                duration_ms: as_u64(row.get(8)?, "duration_ms")
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                stdout_digest: row.get(9)?,
                stderr_digest: row.get(10)?,
            })
        })
        .map_err(|error| format!("failed to query calibration executions: {error}"))?
        .map(|row| {
            row.map_err(|error| {
                format!("invalid persisted calibration execution evidence: {error}")
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Some((summary, metrics, checks, executions)))
}

/// Aggregate qualified planner metrics. Legacy v8 rows and ineligible observations remain in
/// history totals, but are excluded from accuracy and cost averages.
pub fn get_calibration_stats(conn: &Connection) -> Result<CalibrationAggregateStats, String> {
    let mut statement = conn
        .prepare(
            r#"
            SELECT r.status, r.calibration_contract_version,
                   m.candidate_selected_count, m.shadow_reference_count,
                   m.observed_shadow_miss_count, m.selection_ratio, m.runtime_cost_ratio,
                   m.signal_recall, m.eligible_for_miss_rate, m.eligible_for_cost_ratio,
                   m.eligible_for_runtime_comparison
            FROM calibration_runs r
            LEFT JOIN calibration_metrics m ON r.calibration_id = m.calibration_id
            "#,
        )
        .map_err(|error| format!("failed to prepare calibration stats query: {error}"))?;

    let mut result = CalibrationAggregateStats {
        total_calibrations: 0,
        complete_calibrations: 0,
        incomplete_calibrations: 0,
        total_candidate_checks: 0,
        total_shadow_checks: 0,
        total_observed_misses: 0,
        mean_selection_ratio: None,
        mean_runtime_cost_ratio: None,
        mean_signal_recall: None,
    };
    let mut selection_ratios = Vec::new();
    let mut cost_ratios = Vec::new();
    let mut signal_recalls = Vec::new();
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<f64>>(5)?,
                row.get::<_, Option<f64>>(6)?,
                row.get::<_, Option<f64>>(7)?,
                row.get::<_, Option<bool>>(8)?,
                row.get::<_, Option<bool>>(9)?,
                row.get::<_, Option<bool>>(10)?,
            ))
        })
        .map_err(|error| format!("failed to query calibration stats: {error}"))?;
    for row in rows {
        let (
            status,
            contract,
            candidate_count,
            shadow_count,
            miss_count,
            selection_ratio,
            cost_ratio,
            recall,
            eligible_miss,
            eligible_cost,
            eligible_runtime,
        ) = row.map_err(|error| format!("invalid calibration stats row: {error}"))?;
        result.total_calibrations += 1;
        match parse_calibration_status(&status)? {
            CalibrationStatus::Complete => result.complete_calibrations += 1,
            CalibrationStatus::Incomplete | CalibrationStatus::Failed => {
                result.incomplete_calibrations += 1
            }
        }
        result.total_candidate_checks +=
            optional_usize(candidate_count, "candidate_selected_count")?;
        result.total_shadow_checks += optional_usize(shadow_count, "shadow_reference_count")?;
        result.total_observed_misses += optional_usize(miss_count, "observed_shadow_miss_count")?;
        if contract == CALIBRATION_CONTRACT_VERSION as i64 {
            if eligible_runtime == Some(true) {
                if let Some(value) = selection_ratio {
                    selection_ratios.push(value);
                }
            }
            if eligible_cost == Some(true) {
                if let Some(value) = cost_ratio {
                    cost_ratios.push(value);
                }
            }
            if eligible_miss == Some(true) {
                if let Some(value) = recall {
                    signal_recalls.push(value);
                }
            }
        }
    }
    result.mean_selection_ratio = mean(&selection_ratios);
    result.mean_runtime_cost_ratio = mean(&cost_ratios);
    result.mean_signal_recall = mean(&signal_recalls);
    Ok(result)
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CalibrationRunSummary> {
    let status: String = row.get(7)?;
    Ok(CalibrationRunSummary {
        calibration_id: row.get(0)?,
        calibration_contract_version: row.get::<_, i64>(1)? as u32,
        source_run_id: row.get(2)?,
        source_artifact_sha256: row.get(3)?,
        candidate_plan_digest: row.get(4)?,
        policy_digest: row.get(5)?,
        record_digest: row.get(6)?,
        status: parse_calibration_status(&status).map_err(|_| rusqlite::Error::InvalidQuery)?,
        reference_scope: row.get(8)?,
        candidate_selected_count: optional_usize(row.get(9)?, "candidate_selected_count")
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        shadow_reference_count: optional_usize(row.get(10)?, "shadow_reference_count")
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        observed_shadow_miss_count: optional_usize(row.get(11)?, "observed_shadow_miss_count")
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        signal_recall: row.get(12)?,
        started_at_ms: as_u64(row.get(13)?, "started_at_ms")
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        duration_ms: as_u64(row.get(14)?, "duration_ms")
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
    })
}

fn parse_calibration_status(value: &str) -> Result<CalibrationStatus, String> {
    match value {
        "complete" => Ok(CalibrationStatus::Complete),
        "incomplete" => Ok(CalibrationStatus::Incomplete),
        "failed" => Ok(CalibrationStatus::Failed),
        _ => Err(format!("unknown calibration status '{value}'")),
    }
}

fn parse_status(value: &str) -> Result<CheckExecutionStatus, String> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(|_| format!("unknown execution status '{value}'"))
}

fn parse_kind(value: &str) -> Result<VerificationCheckKind, String> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(|_| format!("unknown verification check kind '{value}'"))
}

fn parse_signal_class(value: &str) -> Result<SignalClass, String> {
    match value {
        "selected_signal" => Ok(SignalClass::SelectedSignal),
        "observed_shadow_miss" => Ok(SignalClass::ObservedShadowMiss),
        "selected_pass" => Ok(SignalClass::SelectedPass),
        "unselected_pass" => Ok(SignalClass::UnselectedPass),
        "incomplete" => Ok(SignalClass::Incomplete),
        _ => Err(format!("unknown signal class '{value}'")),
    }
}

fn parse_origin(value: &str) -> Result<CalibrationExecutionOrigin, String> {
    match value {
        "candidate_source" => Ok(CalibrationExecutionOrigin::CandidateSource),
        "shadow_reference" => Ok(CalibrationExecutionOrigin::ShadowReference),
        _ => Err(format!("unknown calibration execution origin '{value}'")),
    }
}

fn required_text(value: Option<String>, field: &str) -> rusqlite::Result<String> {
    value.ok_or_else(|| {
        let _ = field;
        rusqlite::Error::InvalidQuery
    })
}

fn as_u64(value: i64, field: &str) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| format!("negative persisted {field}"))
}

fn as_usize(value: i64, field: &str) -> Result<usize, String> {
    usize::try_from(value).map_err(|_| format!("negative persisted {field}"))
}

fn as_u64_sql(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn as_usize_sql(value: i64) -> rusqlite::Result<usize> {
    usize::try_from(value).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn optional_usize(value: Option<i64>, field: &str) -> Result<usize, String> {
    value
        .map(|value| as_usize(value, field))
        .transpose()
        .map(|value| value.unwrap_or(0))
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}
