//! Transactional SQLite persistence for shadow calibration runs and metrics.

use crate::intelligence::calibration::model::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::time::{SystemTime, UNIX_EPOCH};

/// Persist a completed CalibrationRun record and its metrics into SQLite atomically.
///
/// Guaranteed properties:
/// - Atomic transaction: failure leaves zero partial records.
/// - Deterministic idempotency: exact duplicate inserts return Ok(()).
/// - Conflict detection: identical calibration_id with divergent data fails loudly.
pub fn persist_calibration_run(conn: &mut Connection, run: &CalibrationRun) -> Result<(), String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let tx = conn
        .transaction()
        .map_err(|e| format!("failed to start calibration persistence transaction: {}", e))?;

    // 1. Idempotency & Conflict Check
    let existing_run: Option<(String, String, String, String)> = tx
        .query_row(
            r#"
            SELECT source_run_id, candidate_plan_digest, policy_digest, status
            FROM calibration_runs
            WHERE calibration_id = ?1
            "#,
            params![run.calibration_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| format!("failed to query existing calibration run: {}", e))?;

    if let Some((src, plan_dig, pol_dig, status_str)) = existing_run {
        let is_identical = src == run.source_run_id
            && plan_dig == run.candidate_plan_digest
            && pol_dig == run.policy_digest
            && status_str == run.status.as_str();

        if is_identical {
            return Ok(());
        } else {
            return Err(format!(
                "Calibration persistence conflict: calibration_id '{}' already exists with divergent data (src: {} vs {}, plan: {} vs {}, policy: {} vs {})",
                run.calibration_id, src, run.source_run_id, plan_dig, run.candidate_plan_digest, pol_dig, run.policy_digest
            ));
        }
    }

    // 2. Insert top-level calibration run
    tx.execute(
        r#"
        INSERT INTO calibration_runs (
            calibration_id, source_run_id, candidate_plan_digest, policy_digest,
            status, reference_scope, max_shadow_checks, reference_truncated,
            started_at_ms, completed_at_ms, duration_ms, created_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        "#,
        params![
            run.calibration_id,
            run.source_run_id,
            run.candidate_plan_digest,
            run.policy_digest,
            run.status.as_str(),
            run.policy.scope.as_str(),
            run.policy.max_shadow_checks as i64,
            run.reference_truncated,
            run.started_at_ms as i64,
            run.completed_at_ms as i64,
            run.duration_ms as i64,
            now_ms as i64,
        ],
    )
    .map_err(|e| format!("failed to insert into calibration_runs: {}", e))?;

    // 3. Insert shadow check observations
    let mut check_stmt = tx
        .prepare(
            r#"
            INSERT INTO calibration_checks (
                calibration_id, check_id, candidate_selected, reference_selected,
                execution_status, has_physical_execution, duration_ms,
                signal_class, is_observed_shadow_miss, reason
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
        )
        .map_err(|e| format!("failed to prepare check statement: {}", e))?;

    for check in &run.checks {
        let status_str = serde_json::to_value(check.execution_status)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| "unsupported".to_string());

        check_stmt
            .execute(params![
                run.calibration_id,
                check.check_id,
                check.candidate_selected,
                check.reference_selected,
                status_str,
                check.has_physical_execution,
                check.duration_ms as i64,
                check.signal_class.as_str(),
                check.is_observed_shadow_miss,
                check.reason,
            ])
            .map_err(|e| {
                format!(
                    "failed to insert check observation '{}': {}",
                    check.check_id, e
                )
            })?;
    }
    drop(check_stmt);

    // 4. Insert shadow executions
    let mut exec_stmt = tx
        .prepare(
            r#"
            INSERT INTO calibration_executions (
                calibration_id, execution_id, check_id, program, argv_digest,
                cwd, status, exit_code, duration_ms, stdout_digest, stderr_digest
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            "#,
        )
        .map_err(|e| format!("failed to prepare execution statement: {}", e))?;

    for exec in &run.executions {
        let status_str = serde_json::to_value(exec.status)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| "unsupported".to_string());

        exec_stmt
            .execute(params![
                run.calibration_id,
                exec.execution_id,
                exec.check_id,
                exec.program,
                exec.argv_digest,
                exec.cwd,
                status_str,
                exec.exit_code,
                exec.duration_ms as i64,
                exec.stdout_digest,
                exec.stderr_digest,
            ])
            .map_err(|e| {
                format!(
                    "failed to insert shadow execution '{}': {}",
                    exec.execution_id, e
                )
            })?;
    }
    drop(exec_stmt);

    // 5. Insert calibration metrics
    tx.execute(
        r#"
        INSERT INTO calibration_metrics (
            calibration_id, candidate_selected_count, shadow_reference_count,
            shadow_executed_count, selected_failure_count, unselected_failure_count,
            observed_shadow_miss_count, shadow_incomplete_count,
            candidate_execution_duration_ms, shadow_reference_duration_ms,
            selection_ratio, runtime_cost_ratio, signal_recall,
            eligible_for_miss_rate, eligible_for_cost_ratio, eligible_for_runtime_comparison
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
        "#,
        params![
            run.calibration_id,
            run.metrics.candidate_selected_count as i64,
            run.metrics.shadow_reference_count as i64,
            run.metrics.shadow_executed_count as i64,
            run.metrics.selected_failure_count as i64,
            run.metrics.unselected_failure_count as i64,
            run.metrics.observed_shadow_miss_count as i64,
            run.metrics.shadow_incomplete_count as i64,
            run.metrics.candidate_execution_duration_ms as i64,
            run.metrics.shadow_reference_duration_ms as i64,
            run.metrics.selection_ratio,
            run.metrics.runtime_cost_ratio,
            run.metrics.signal_recall,
            run.metrics.eligibility.eligible_for_miss_rate,
            run.metrics.eligibility.eligible_for_cost_ratio,
            run.metrics.eligibility.eligible_for_runtime_comparison,
        ],
    )
    .map_err(|e| format!("failed to insert into calibration_metrics: {}", e))?;

    tx.commit()
        .map_err(|e| format!("failed to commit calibration transaction: {}", e))?;

    Ok(())
}
