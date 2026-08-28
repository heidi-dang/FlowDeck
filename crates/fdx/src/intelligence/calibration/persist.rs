//! Transactional SQLite persistence for qualified shadow calibration runs and metrics.

use crate::intelligence::calibration::evaluate::compute_calibration_record_digest;
use crate::intelligence::calibration::model::*;
use crate::intelligence::verify::redact::redact_secrets;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::{Component, Path};
use std::time::{SystemTime, UNIX_EPOCH};

/// Persist a completed CalibrationRun record atomically.
///
/// The deterministic calibration key permits idempotency only when the canonical semantic
/// record digest is identical. Divergent evidence for an existing key is always a conflict.
pub fn persist_calibration_run(conn: &mut Connection, run: &CalibrationRun) -> Result<(), String> {
    validate_run_for_persistence(run)?;
    let recomputed_digest = compute_calibration_record_digest(run)?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to start calibration persistence transaction: {error}"))?;

    let existing: Option<(i64, Option<String>)> = tx
        .query_row(
            "SELECT calibration_contract_version, record_digest FROM calibration_runs WHERE calibration_id = ?1",
            params![run.calibration_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("failed to query existing calibration run: {error}"))?;
    if let Some((contract_version, existing_digest)) = existing {
        if contract_version == CALIBRATION_CONTRACT_VERSION as i64
            && existing_digest.as_deref() == Some(recomputed_digest.as_str())
        {
            return Ok(());
        }
        return Err(format!(
            "calibration record conflict (CalibrationRecordConflict): calibration_id '{}' already stores divergent or legacy evidence",
            run.calibration_id
        ));
    }

    if recomputed_digest != run.record_digest {
        return Err("calibration record digest does not match normalized evidence".to_string());
    }

    tx.execute(
        r#"
        INSERT INTO calibration_runs (
            calibration_id, source_run_id, candidate_plan_digest, policy_digest, status,
            reference_scope, max_shadow_checks, reference_truncated, started_at_ms,
            completed_at_ms, duration_ms, created_at_ms, calibration_contract_version,
            source_artifact_sha256, record_digest, max_total_duration_ms,
            per_check_timeout_ms, max_output_bytes
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
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
            run.calibration_contract_version as i64,
            run.source_artifact_sha256,
            run.record_digest,
            run.policy.max_total_duration_ms as i64,
            run.policy.per_check_timeout_ms as i64,
            run.policy.max_output_bytes as i64,
        ],
    )
    .map_err(|error| format!("failed to insert calibration run: {error}"))?;

    let mut check_statement = tx
        .prepare(
            r#"
            INSERT INTO calibration_checks (
                calibration_id, check_id, candidate_selected, reference_selected,
                execution_status, has_physical_execution, duration_ms, signal_class,
                is_observed_shadow_miss, reason, display_name, kind, scope, execution_id,
                reused_execution
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            "#,
        )
        .map_err(|error| format!("failed to prepare check insert: {error}"))?;
    for check in &run.checks {
        check_statement
            .execute(params![
                run.calibration_id,
                check.check_id,
                check.candidate_selected,
                check.reference_selected,
                status_string(check.execution_status)?,
                check.has_physical_execution,
                check.duration_ms as i64,
                check.signal_class.as_str(),
                check.is_observed_shadow_miss,
                check.reason,
                check.display_name,
                check.kind.as_str(),
                check.scope,
                check.execution_id,
                check.reused_execution,
            ])
            .map_err(|error| {
                format!(
                    "failed to insert calibration check '{}': {error}",
                    check.check_id
                )
            })?;
    }
    drop(check_statement);

    let mut execution_statement = tx
        .prepare(
            r#"
            INSERT INTO calibration_executions (
                calibration_id, execution_id, check_id, program, argv_digest, cwd, status,
                exit_code, duration_ms, stdout_digest, stderr_digest, origin
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            "#,
        )
        .map_err(|error| format!("failed to prepare execution insert: {error}"))?;
    for execution in &run.executions {
        execution_statement
            .execute(params![
                run.calibration_id,
                execution.execution_id,
                execution.check_id,
                execution.program,
                execution.argv_digest,
                execution.cwd,
                status_string(execution.status)?,
                execution.exit_code,
                execution.duration_ms as i64,
                execution.stdout_digest,
                execution.stderr_digest,
                execution.origin.as_str(),
            ])
            .map_err(|error| {
                format!(
                    "failed to insert calibration execution '{}': {error}",
                    execution.execution_id
                )
            })?;
    }
    drop(execution_statement);

    tx.execute(
        r#"
        INSERT INTO calibration_metrics (
            calibration_id, candidate_selected_count, shadow_reference_count,
            shadow_executed_count, candidate_physical_execution_count,
            shadow_physical_execution_count, selected_failure_count, unselected_failure_count,
            observed_shadow_miss_count, shadow_incomplete_count,
            candidate_execution_duration_ms, shadow_reference_duration_ms, selection_ratio,
            runtime_cost_ratio, signal_recall, eligible_for_miss_rate,
            eligible_for_cost_ratio, eligible_for_runtime_comparison
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
        "#,
        params![
            run.calibration_id,
            run.metrics.candidate_selected_count as i64,
            run.metrics.shadow_reference_count as i64,
            run.metrics.shadow_executed_count as i64,
            run.metrics.candidate_physical_execution_count as i64,
            run.metrics.shadow_physical_execution_count as i64,
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
    .map_err(|error| format!("failed to insert calibration metrics: {error}"))?;

    tx.commit()
        .map_err(|error| format!("failed to commit calibration transaction: {error}"))
}

fn status_string(
    status: crate::intelligence::verify::model::CheckExecutionStatus,
) -> Result<String, String> {
    serde_json::to_value(status)
        .map_err(|error| format!("cannot serialize execution status: {error}"))?
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "serialized execution status was not a string".to_string())
}

fn validate_run_for_persistence(run: &CalibrationRun) -> Result<(), String> {
    if run.calibration_contract_version != CALIBRATION_CONTRACT_VERSION {
        return Err("only qualified calibration contract version 2 may be persisted".to_string());
    }
    if run.source_artifact_sha256.trim().is_empty() || run.record_digest.trim().is_empty() {
        return Err("qualified calibration requires source and record digests".to_string());
    }
    let execution_ids: std::collections::HashSet<&str> = run
        .executions
        .iter()
        .map(|execution| execution.execution_id.as_str())
        .collect();
    if execution_ids.len() != run.executions.len() {
        return Err("calibration contains duplicate physical execution IDs".to_string());
    }
    for check in &run.checks {
        if check.has_physical_execution != check.execution_id.is_some() {
            return Err(format!(
                "check '{}' has inconsistent physical execution linkage",
                check.check_id
            ));
        }
        if let Some(execution_id) = &check.execution_id {
            if !execution_ids.contains(execution_id.as_str()) {
                return Err(format!(
                    "check '{}' references missing execution '{}'",
                    check.check_id, execution_id
                ));
            }
        }
        if let Some(reason) = &check.reason {
            if reason != &redact_secrets(reason)
                || (reason.contains("sk-proj-") && !reason.contains("sk-proj-[REDACTED]"))
                || reason.contains("/home/")
                || reason.contains("/Users/")
            {
                return Err(format!(
                    "check '{}' reason was not redacted before persistence",
                    check.check_id
                ));
            }
        }
    }
    for execution in &run.executions {
        if Path::new(&execution.cwd).is_absolute()
            || Path::new(&execution.cwd)
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(format!(
                "execution '{}' contains an unsafe persisted cwd",
                execution.execution_id
            ));
        }
        if Path::new(&execution.program).is_absolute() {
            return Err(format!(
                "execution '{}' contains an absolute program path",
                execution.execution_id
            ));
        }
    }
    Ok(())
}
