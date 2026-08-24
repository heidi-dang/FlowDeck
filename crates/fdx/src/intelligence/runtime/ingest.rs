//! Atomic, transactional ingestion of M7 VerificationRun artifacts into SQLite.

use crate::intelligence::runtime::digest::{
    compute_argv_digest, compute_plan_digest, sha256_bytes,
};
use crate::intelligence::runtime::model::RuntimeIngestResult;
use crate::intelligence::verify::model::VerificationRun;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum allowed size for an imported runtime artifact (16 MB).
pub const MAX_RUNTIME_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;

/// Ingest an in-memory VerificationRun with its raw artifact bytes atomically.
pub fn ingest_verification_run(
    conn: &mut Connection,
    run: &VerificationRun,
    _raw_artifact_bytes: Option<&[u8]>,
) -> Result<RuntimeIngestResult, String> {
    let run_id = &run.run_id;
    if run_id.trim().is_empty() {
        return Ok(RuntimeIngestResult::Failed {
            run_id: None,
            reason: "empty run_id in verification run".to_string(),
        });
    }

    // 1. Calculate canonical artifact digest
    let serialized = serde_json::to_vec_pretty(run)
        .map_err(|e| format!("failed to serialize run for digest: {}", e))?;
    let artifact_digest = sha256_bytes(&serialized);

    // 2. Check if run_id already exists in SQLite
    let existing_digest: Option<String> = conn
        .query_row(
            "SELECT artifact_digest FROM runtime_runs WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("query error checking existing run: {}", e))?;

    if let Some(existing) = existing_digest {
        if existing == artifact_digest {
            return Ok(RuntimeIngestResult::AlreadyImported {
                run_id: run_id.clone(),
                artifact_digest,
            });
        } else {
            return Ok(RuntimeIngestResult::Conflict {
                run_id: run_id.clone(),
                existing_digest: existing,
                incoming_digest: artifact_digest,
            });
        }
    }

    // 3. Validate plan and compute plan digest
    let plan_digest =
        compute_plan_digest(&run.plan).map_err(|e| format!("cannot compute plan digest: {}", e))?;

    // 4. Validate check obligations and executions
    let mut distinct_executions = HashSet::new();
    let mut distinct_checks = HashSet::new();

    for check in &run.checks {
        if !distinct_checks.insert(&check.check_id) {
            return Ok(RuntimeIngestResult::Failed {
                run_id: Some(run_id.clone()),
                reason: format!("duplicate check_id in artifact checks: {}", check.check_id),
            });
        }
        if check.execution_id.trim().is_empty() {
            return Ok(RuntimeIngestResult::Failed {
                run_id: Some(run_id.clone()),
                reason: format!("check {} has empty execution_id", check.check_id),
            });
        }
        distinct_executions.insert(&check.execution_id);
    }

    // 5. Begin transaction
    let tx = conn
        .transaction()
        .map_err(|e| format!("failed to start transaction: {}", e))?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let outcome_str = serde_json::to_string(&run.outcome)
        .unwrap_or_default()
        .trim_matches('"')
        .to_string();
    let assurance_str = serde_json::to_string(&run.assurance)
        .unwrap_or_default()
        .trim_matches('"')
        .to_string();

    // Insert runtime_runs row
    tx.execute(
        r#"
        INSERT INTO runtime_runs (
            run_id, artifact_digest, plan_digest, outcome, assurance,
            executed_at_ms, duration_ms, base_ref, head_ref, imported_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
        params![
            run_id,
            artifact_digest,
            plan_digest,
            outcome_str,
            assurance_str,
            run.executed_at_ms as i64,
            run.duration_ms as i64,
            run.base,
            run.head,
            now_ms,
        ],
    )
    .map_err(|e| format!("failed to insert runtime_runs row: {}", e))?;

    // Deduplicate process executions: insert each unique execution exactly once
    let mut inserted_execs = HashSet::new();
    for check in &run.checks {
        if inserted_execs.insert(&check.execution_id) {
            let argv_digest = compute_argv_digest(&check.command);
            let status_str = serde_json::to_string(&check.status)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string();
            let prog = check
                .command
                .first()
                .cloned()
                .unwrap_or_else(|| "unknown".to_string());

            tx.execute(
                r#"
                INSERT INTO runtime_executions (
                    run_id, execution_id, program, argv_digest, cwd,
                    status, exit_code, duration_ms, stdout_digest, stderr_digest,
                    stdout_captured_bytes, stderr_captured_bytes, output_truncated
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                "#,
                params![
                    run_id,
                    check.execution_id,
                    prog,
                    argv_digest,
                    check.cwd,
                    status_str,
                    check.exit_code,
                    check.duration_ms as i64,
                    check.stdout_digest,
                    check.stderr_digest,
                    check.stdout_captured_bytes as i64,
                    check.stderr_captured_bytes as i64,
                    check.stdout_truncated || check.stderr_truncated,
                ],
            )
            .map_err(|e| format!("failed to insert runtime_executions row: {}", e))?;
        }
    }

    // Insert check observations
    for check in &run.checks {
        let kind_str = serde_json::to_string(&check.kind)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        let status_str = serde_json::to_string(&check.status)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();

        // Find planned check mandatory flag if available
        let mandatory = run
            .plan
            .selected_checks
            .iter()
            .find(|c| c.check_id == check.check_id)
            .map(|c| c.mandatory)
            .unwrap_or(true);

        tx.execute(
            r#"
            INSERT INTO runtime_check_observations (
                run_id, check_id, execution_id, kind, status, reused_execution, mandatory
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                run_id,
                check.check_id,
                check.execution_id,
                kind_str,
                status_str,
                check.reused_execution,
                mandatory,
            ],
        )
        .map_err(|e| format!("failed to insert runtime_check_observations row: {}", e))?;
    }

    // Insert changed entity co-occurrence observations
    for change in &run.plan.changed {
        let change_kind_str = serde_json::to_string(&change.change_kind)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();

        tx.execute(
            r#"
            INSERT OR IGNORE INTO runtime_change_observations (
                run_id, entity_id, entity_kind
            ) VALUES (?1, ?2, ?3)
            "#,
            params![run_id, change.file, change_kind_str],
        )
        .map_err(|e| format!("failed to insert runtime_change_observations row: {}", e))?;
    }

    tx.commit()
        .map_err(|e| format!("failed to commit ingestion transaction: {}", e))?;

    Ok(RuntimeIngestResult::Imported {
        run_id: run_id.clone(),
        artifact_digest,
    })
}
