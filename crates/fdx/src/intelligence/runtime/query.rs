//! Read-only queries over historical runtime verification observations.

use crate::intelligence::runtime::model::{
    RuntimeCheckObservation, RuntimeExecutionObservation, RuntimeRunObservation,
};
use crate::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use crate::protocol::AssuranceLevel;
use rusqlite::{params, Connection, OptionalExtension};

/// List historical verification runs sorted descending by execution timestamp.
pub fn list_historical_runs(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<RuntimeRunObservation>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT run_id, artifact_digest, plan_digest, outcome, assurance,
                   executed_at_ms, duration_ms, base_ref, head_ref, imported_at_ms
            FROM runtime_runs
            ORDER BY executed_at_ms DESC, run_id DESC
            LIMIT ?1
            "#,
        )
        .map_err(|e| format!("prepare error: {}", e))?;

    let rows = stmt
        .query_map(params![limit as i64], |row| {
            let outcome_str: String = row.get(3)?;
            let assurance_str: String = row.get(4)?;
            let executed_at_ms: i64 = row.get(5)?;
            let duration_ms: i64 = row.get(6)?;
            let imported_at_ms: i64 = row.get(9)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                outcome_str,
                assurance_str,
                executed_at_ms as u64,
                duration_ms as u64,
                row.get(7)?,
                row.get(8)?,
                imported_at_ms as u64,
            ))
        })
        .map_err(|e| format!("query error: {}", e))?;

    let mut runs = Vec::new();
    for r in rows {
        let (
            run_id,
            artifact_digest,
            plan_digest,
            outcome_str,
            assurance_str,
            executed_at_ms,
            duration_ms,
            base,
            head,
            imported_at_ms,
        ) = r.map_err(|e| format!("row error: {}", e))?;

        let outcome: VerificationOutcome = serde_json::from_str(&format!("\"{}\"", outcome_str))
            .unwrap_or(VerificationOutcome::Incomplete);
        let assurance: AssuranceLevel = serde_json::from_str(&format!("\"{}\"", assurance_str))
            .unwrap_or(AssuranceLevel::Unverified);

        runs.push(RuntimeRunObservation {
            run_id,
            artifact_digest,
            plan_digest,
            outcome,
            assurance,
            executed_at_ms,
            duration_ms,
            base,
            head,
            imported_at_ms,
        });
    }

    Ok(runs)
}

/// Retrieve a single historical run and its executions/checks.
pub fn get_historical_run(
    conn: &Connection,
    run_id: &str,
) -> Result<
    Option<(
        RuntimeRunObservation,
        Vec<RuntimeExecutionObservation>,
        Vec<RuntimeCheckObservation>,
    )>,
    String,
> {
    let run_row: Option<(
        String,
        String,
        String,
        String,
        String,
        i64,
        i64,
        Option<String>,
        Option<String>,
        i64,
    )> = conn
        .query_row(
            r#"
            SELECT run_id, artifact_digest, plan_digest, outcome, assurance,
                   executed_at_ms, duration_ms, base_ref, head_ref, imported_at_ms
            FROM runtime_runs
            WHERE run_id = ?1
            "#,
            params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("query error: {}", e))?;

    let (
        run_id_val,
        artifact_digest,
        plan_digest,
        outcome_str,
        assurance_str,
        executed_at_ms_i64,
        duration_ms_i64,
        base,
        head,
        imported_at_ms_i64,
    ) = match run_row {
        Some(val) => val,
        None => return Ok(None),
    };

    let outcome: VerificationOutcome = serde_json::from_str(&format!("\"{}\"", outcome_str))
        .unwrap_or(VerificationOutcome::Incomplete);
    let assurance: AssuranceLevel = serde_json::from_str(&format!("\"{}\"", assurance_str))
        .unwrap_or(AssuranceLevel::Unverified);

    let run_obs = RuntimeRunObservation {
        run_id: run_id_val,
        artifact_digest,
        plan_digest,
        outcome,
        assurance,
        executed_at_ms: executed_at_ms_i64 as u64,
        duration_ms: duration_ms_i64 as u64,
        base,
        head,
        imported_at_ms: imported_at_ms_i64 as u64,
    };

    // Fetch executions
    let mut exec_stmt = conn
        .prepare(
            r#"
            SELECT execution_id, run_id, program, argv_digest, cwd, status,
                   exit_code, duration_ms, stdout_digest, stderr_digest,
                   stdout_captured_bytes, stderr_captured_bytes, output_truncated
            FROM runtime_executions
            WHERE run_id = ?1
            ORDER BY execution_id ASC
            "#,
        )
        .map_err(|e| format!("exec prepare error: {}", e))?;

    let exec_rows = exec_stmt
        .query_map(params![run_id], |row| {
            let status_str: String = row.get(5)?;
            let duration_ms: i64 = row.get(7)?;
            let stdout_captured_bytes: i64 = row.get(10)?;
            let stderr_captured_bytes: i64 = row.get(11)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                status_str,
                row.get(6)?,
                duration_ms as u64,
                row.get(8)?,
                row.get(9)?,
                stdout_captured_bytes as u64,
                stderr_captured_bytes as u64,
                row.get(12)?,
            ))
        })
        .map_err(|e| format!("exec query error: {}", e))?;

    let mut executions = Vec::new();
    for er in exec_rows {
        let (
            execution_id,
            run_id,
            program,
            argv_digest,
            cwd,
            status_str,
            exit_code,
            duration_ms,
            stdout_digest,
            stderr_digest,
            stdout_captured_bytes,
            stderr_captured_bytes,
            output_truncated,
        ) = er.map_err(|e| format!("exec row error: {}", e))?;
        let status: CheckExecutionStatus = serde_json::from_str(&format!("\"{}\"", status_str))
            .unwrap_or(CheckExecutionStatus::Unsupported);

        executions.push(RuntimeExecutionObservation {
            execution_id,
            run_id,
            program,
            argv_digest,
            cwd,
            status,
            exit_code,
            duration_ms,
            stdout_digest,
            stderr_digest,
            stdout_captured_bytes,
            stderr_captured_bytes,
            output_truncated,
        });
    }

    // Fetch check observations
    let mut check_stmt = conn
        .prepare(
            r#"
            SELECT run_id, check_id, execution_id, kind, status, reused_execution, mandatory
            FROM runtime_check_observations
            WHERE run_id = ?1
            ORDER BY check_id ASC
            "#,
        )
        .map_err(|e| format!("check prepare error: {}", e))?;

    let check_rows = check_stmt
        .query_map(params![run_id], |row| {
            let kind_str: String = row.get(3)?;
            let status_str: String = row.get(4)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                kind_str,
                status_str,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .map_err(|e| format!("check query error: {}", e))?;

    let mut checks = Vec::new();
    for cr in check_rows {
        let (run_id, check_id, execution_id, kind_str, status_str, reused_execution, mandatory) =
            cr.map_err(|e| format!("check row error: {}", e))?;
        let kind = serde_json::from_str(&format!("\"{}\"", kind_str))
            .unwrap_or(crate::intelligence::testplan::model::VerificationCheckKind::UnitTest);
        let status: CheckExecutionStatus = serde_json::from_str(&format!("\"{}\"", status_str))
            .unwrap_or(CheckExecutionStatus::Unsupported);

        checks.push(RuntimeCheckObservation {
            run_id,
            check_id,
            execution_id,
            kind,
            status,
            reused_execution,
            mandatory,
        });
    }

    Ok(Some((run_obs, executions, checks)))
}
