//! Atomic, transactional ingestion of M7 VerificationRun artifacts into SQLite.

use crate::intelligence::runtime::digest::{
    compute_argv_digest, compute_plan_digest, sha256_bytes,
};
use crate::intelligence::runtime::model::{RuntimeIngestResult, INGESTION_CONTRACT_VERSION_V2};
use crate::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, VerificationRun,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum allowed size for an imported runtime artifact (16 MB).
pub const MAX_RUNTIME_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;

/// Classify whether a check execution status positively establishes that an OS process executed.
pub fn is_physical_process_execution(status: &CheckExecutionStatus) -> bool {
    matches!(
        status,
        CheckExecutionStatus::Passed
            | CheckExecutionStatus::Failed
            | CheckExecutionStatus::TimedOut
            | CheckExecutionStatus::OutputLimitExceeded
    )
}

/// Ingest a raw persisted M7 VerificationRun artifact JSON byte slice atomically.
pub fn ingest_verification_artifact(
    conn: &mut Connection,
    raw_artifact_bytes: &[u8],
) -> Result<RuntimeIngestResult, String> {
    // 1. Enforce size bound
    if raw_artifact_bytes.len() as u64 > MAX_RUNTIME_ARTIFACT_BYTES {
        return Ok(RuntimeIngestResult::Failed {
            run_id: None,
            reason: format!(
                "artifact size ({} bytes) exceeds maximum bound of {} bytes",
                raw_artifact_bytes.len(),
                MAX_RUNTIME_ARTIFACT_BYTES
            ),
        });
    }

    // 2. Exact artifact byte SHA-256 digest
    let artifact_digest = sha256_bytes(raw_artifact_bytes);

    // 3. Parse VerificationRun from exact bytes
    let run: VerificationRun = match serde_json::from_slice(raw_artifact_bytes) {
        Ok(r) => r,
        Err(e) => {
            return Ok(RuntimeIngestResult::Failed {
                run_id: None,
                reason: format!("malformed json in verification artifact: {}", e),
            });
        }
    };

    let run_id = run.run_id.trim().to_string();
    if run_id.is_empty() {
        return Ok(RuntimeIngestResult::Failed {
            run_id: None,
            reason: "empty run_id in verification run".to_string(),
        });
    }

    // 4. Validate plan digest
    let plan_digest =
        compute_plan_digest(&run.plan).map_err(|e| format!("cannot compute plan digest: {}", e))?;

    // 5. Build planned checks map to strictly validate check relationships (no invented mandatory flags)
    let mut planned_checks_map = HashMap::new();
    for pc in &run.plan.selected_checks {
        planned_checks_map.insert(pc.check_id.as_str(), pc.mandatory);
    }

    // 6. Validate checks and group by execution_id
    let mut distinct_checks = HashSet::new();
    let mut exec_groups: HashMap<
        &str,
        Vec<&crate::intelligence::verify::model::CheckExecutionResult>,
    > = HashMap::new();

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

        // Strict plan correspondence: check MUST exist in planned checks
        if !planned_checks_map.contains_key(check.check_id.as_str()) {
            return Ok(RuntimeIngestResult::Failed {
                run_id: Some(run_id.clone()),
                reason: format!(
                    "check '{}' was executed but is absent from plan.selected_checks",
                    check.check_id
                ),
            });
        }

        exec_groups
            .entry(check.execution_id.as_str())
            .or_default()
            .push(check);
    }

    // 7. Validate shared execution evidence consistency, physicality uniformity, and reuse patterns
    struct ValidatedExecutionGroup<'a> {
        has_physical_execution: bool,
        canonical_check: &'a CheckExecutionResult,
    }

    let mut validated_groups: HashMap<&str, ValidatedExecutionGroup> = HashMap::new();

    for (exec_id, group) in &exec_groups {
        let first = group[0];
        let first_physical = is_physical_process_execution(&first.status);

        // Verify group physicality is uniform across ALL members (ordering-independent)
        for other in &group[1..] {
            let other_physical = is_physical_process_execution(&other.status);
            if other_physical != first_physical {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!(
                        "execution_id '{}' mixes physical and non-physical observations ('{:?}' vs '{:?}')",
                        exec_id, first.status, other.status
                    ),
                });
            }
        }

        // Count primary vs reused for EVERY group (physical and non-physical)
        let primary_count = group.iter().filter(|c| !c.reused_execution).count();
        if primary_count != 1 {
            return Ok(RuntimeIngestResult::Failed {
                run_id: Some(run_id.clone()),
                reason: format!(
                    "execution_id '{}' has invalid reuse pattern: {} non-reused obligations (expected exactly 1)",
                    exec_id, primary_count
                ),
            });
        }

        // Verify all members in the group share identical evidence regardless of physical status
        for other in &group[1..] {
            if other.status != first.status {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!(
                        "execution_id '{}' has conflicting status: '{:?}' vs '{:?}'",
                        exec_id, first.status, other.status
                    ),
                });
            }
            if other.command != first.command {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!(
                        "execution_id '{}' has conflicting commands: '{:?}' vs '{:?}'",
                        exec_id, first.command, other.command
                    ),
                });
            }
            if other.cwd != first.cwd {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!(
                        "execution_id '{}' has conflicting cwd: '{}' vs '{}'",
                        exec_id, first.cwd, other.cwd
                    ),
                });
            }
            if other.exit_code != first.exit_code {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!(
                        "execution_id '{}' has conflicting exit_code: '{:?}' vs '{:?}'",
                        exec_id, first.exit_code, other.exit_code
                    ),
                });
            }
            if other.signal != first.signal {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!(
                        "execution_id '{}' has conflicting signal: '{:?}' vs '{:?}'",
                        exec_id, first.signal, other.signal
                    ),
                });
            }
            if other.duration_ms != first.duration_ms {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!(
                        "execution_id '{}' has conflicting duration_ms: {} vs {}",
                        exec_id, first.duration_ms, other.duration_ms
                    ),
                });
            }
            if other.stdout_digest != first.stdout_digest {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!("execution_id '{}' has conflicting stdout_digest", exec_id),
                });
            }
            if other.stderr_digest != first.stderr_digest {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!("execution_id '{}' has conflicting stderr_digest", exec_id),
                });
            }
            if other.stdout_captured_bytes != first.stdout_captured_bytes
                || other.stderr_captured_bytes != first.stderr_captured_bytes
                || other.stdout_truncated != first.stdout_truncated
                || other.stderr_truncated != first.stderr_truncated
            {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!(
                        "execution_id '{}' has conflicting stream capture metadata",
                        exec_id
                    ),
                });
            }
            if other.started_at_ms != first.started_at_ms {
                return Ok(RuntimeIngestResult::Failed {
                    run_id: Some(run_id.clone()),
                    reason: format!(
                        "execution_id '{}' has conflicting started_at_ms: {} vs {}",
                        exec_id, first.started_at_ms, other.started_at_ms
                    ),
                });
            }
        }

        validated_groups.insert(
            *exec_id,
            ValidatedExecutionGroup {
                has_physical_execution: first_physical,
                canonical_check: first,
            },
        );
    }

    // 8. Atomic transaction with BEGIN IMMEDIATE to arbitrate identity safely under concurrency
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("failed to start immediate transaction: {}", e))?;

    // Check if run_id already exists
    let existing_row: Option<(String, i64)> = tx
        .query_row(
            "SELECT artifact_digest, ingestion_contract_version FROM runtime_runs WHERE run_id = ?1",
            params![&run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("query error checking existing run: {}", e))?;

    if let Some((existing_digest, contract_ver)) = existing_row {
        if contract_ver == INGESTION_CONTRACT_VERSION_V2 {
            if existing_digest == artifact_digest {
                return Ok(RuntimeIngestResult::AlreadyImported {
                    run_id: run_id.clone(),
                    artifact_digest,
                });
            } else {
                return Ok(RuntimeIngestResult::Conflict {
                    run_id: run_id.clone(),
                    existing_digest,
                    incoming_digest: artifact_digest,
                });
            }
        } else {
            // Legacy contract version 1: upgrade/rebuild the row with exact artifact bytes
            // Delete old cascade rows for this run
            tx.execute(
                "DELETE FROM runtime_runs WHERE run_id = ?1",
                params![&run_id],
            )
            .map_err(|e| format!("failed to remove legacy run for upgrade: {}", e))?;
        }
    }

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

    // Insert runtime_runs row with ingestion_contract_version = 2
    tx.execute(
        r#"
        INSERT INTO runtime_runs (
            run_id, artifact_digest, plan_digest, outcome, assurance,
            executed_at_ms, duration_ms, base_ref, head_ref, imported_at_ms,
            ingestion_contract_version
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
            INGESTION_CONTRACT_VERSION_V2,
        ],
    )
    .map_err(|e| format!("failed to insert runtime_runs row: {}", e))?;

    // Insert physical process executions ONLY from validated physical groups
    for (exec_id, group_info) in &validated_groups {
        if group_info.has_physical_execution {
            let first = group_info.canonical_check;
            let argv_digest = compute_argv_digest(&first.command);
            let status_str = serde_json::to_string(&first.status)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string();
            let prog = first
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
                    exec_id,
                    prog,
                    argv_digest,
                    first.cwd,
                    status_str,
                    first.exit_code,
                    first.duration_ms as i64,
                    first.stdout_digest,
                    first.stderr_digest,
                    first.stdout_captured_bytes as i64,
                    first.stderr_captured_bytes as i64,
                    first.stdout_truncated || first.stderr_truncated,
                ],
            )
            .map_err(|e| format!("failed to insert runtime_executions row: {}", e))?;
        }
    }

    // Insert check observations (recording obligation truth for every check)
    for check in &run.checks {
        let kind_str = serde_json::to_string(&check.kind)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        let status_str = serde_json::to_string(&check.status)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();

        let mandatory = planned_checks_map
            .get(check.check_id.as_str())
            .copied()
            .unwrap_or(false);

        let has_physical = validated_groups
            .get(check.execution_id.as_str())
            .map(|g| g.has_physical_execution)
            .unwrap_or(false);

        tx.execute(
            r#"
            INSERT INTO runtime_check_observations (
                run_id, check_id, execution_id, kind, status, reused_execution, mandatory,
                has_physical_execution
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                run_id,
                check.check_id,
                check.execution_id,
                kind_str,
                status_str,
                check.reused_execution,
                mandatory,
                has_physical,
            ],
        )
        .map_err(|e| format!("failed to insert runtime_check_observations row: {}", e))?;
    }

    // Assert referential integrity invariant across check observations and executions
    let orphan_physical_checks: i64 = tx
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM runtime_check_observations c
            LEFT JOIN runtime_executions e
              ON e.run_id = c.run_id AND e.execution_id = c.execution_id
            WHERE c.run_id = ?1
              AND c.has_physical_execution = 1
              AND e.execution_id IS NULL
            "#,
            params![&run_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("referential check query error: {}", e))?;

    if orphan_physical_checks != 0 {
        return Err(format!(
            "invariant violation: {} physical check observations lack runtime_executions rows",
            orphan_physical_checks
        ));
    }

    let illegitimate_physical_execs: i64 = tx
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM runtime_check_observations c
            JOIN runtime_executions e
              ON e.run_id = c.run_id AND e.execution_id = c.execution_id
            WHERE c.run_id = ?1
              AND c.has_physical_execution = 0
            "#,
            params![&run_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("referential check query error: {}", e))?;

    if illegitimate_physical_execs != 0 {
        return Err(format!(
            "invariant violation: {} non-physical check observations have runtime_executions rows",
            illegitimate_physical_execs
        ));
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
        run_id,
        artifact_digest,
    })
}
