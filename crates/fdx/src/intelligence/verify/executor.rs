//! Verification plan execution engine.
//!
//! Executes verification actions sequentially in deterministic order under strict bounds.
//! Guaranteed properties:
//! - Direct argument vector spawning (no shell wrapper, no command concatenation).
//! - Subprocess group management and guaranteed termination on timeout or output limit.
//! - Secret redaction before disk persistence.
//! - Bounded stdout/stderr streaming buffers and accurate digest bounds.
//! - Strict CWD path containment.
//! - Typed runner capability targeting and single-execution suite rollup.
//! - Fail-closed handling of unresolved M6 obligations and persistence failures.
//! - Never installs dependencies or modifies source files.

use crate::intelligence::change::uncertainty::UncertaintyReason;
use crate::intelligence::semantic::provider::sha256_hex;
use crate::intelligence::testplan::model::{PlannedCheck, VerificationPlan};
use crate::intelligence::verify::action::ExecutionAction;
use crate::intelligence::verify::aggregate::{aggregate_outcome, propagate_assurance};
use crate::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use crate::intelligence::verify::persist::persist_verification_run;
use crate::intelligence::verify::process::{
    execute_bounded_command, ProcessBounds, RawProcessOutcome,
};
use crate::intelligence::verify::redact::redact_secrets;
use crate::intelligence::verify::resolve::resolve_check_action;
use crate::protocol::AssuranceLevel;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Configuration options for verification execution.
#[derive(Debug, Clone)]
pub struct VerificationExecutorOptions {
    pub bounds: ProcessBounds,
    pub fail_fast: bool,
    pub persist: bool,
    pub base: Option<String>,
    pub head: Option<String>,
}

impl Default for VerificationExecutorOptions {
    fn default() -> Self {
        Self {
            bounds: ProcessBounds::default(),
            fail_fast: false,
            persist: true,
            base: None,
            head: None,
        }
    }
}

/// Execute a verification plan against a repository root.
pub fn execute_verification_plan(
    repo_root: &Path,
    plan: &VerificationPlan,
    options: &VerificationExecutorOptions,
) -> Result<VerificationRun, String> {
    let start_wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let start_instant = Instant::now();

    // Generate unique run identifier combining timestamp and plan content digest
    let plan_repr = serde_json::to_string(&plan).unwrap_or_default();
    let plan_hash = sha256_hex(plan_repr.as_bytes());
    let run_id = format!("run_{}_{}", start_wall, &plan_hash[..12]);

    // Handle check deduplication and detect conflicting planned checks
    let mut seen_checks: HashMap<&str, &PlannedCheck> = HashMap::new();
    let mut unique_checks: Vec<&PlannedCheck> = Vec::new();
    let mut conflicting_check_ids: HashMap<String, String> = HashMap::new();
    let mut dedup_uncertainties: Vec<UncertaintyReason> = Vec::new();

    for check in &plan.selected_checks {
        if let Some(existing) = seen_checks.get(check.check_id.as_str()) {
            // Check if definition is identical
            let is_identical = existing.kind == check.kind
                && existing.scope == check.scope
                && existing.reason == check.reason
                && existing.selection == check.selection
                && existing.strength == check.strength
                && existing.mandatory == check.mandatory
                && existing.widening_reason == check.widening_reason;

            if !is_identical {
                conflicting_check_ids.insert(
                    check.check_id.clone(),
                    format!(
                        "conflicting duplicate check '{}' in plan (kind: {:?} vs {:?}, scope: {} vs {})",
                        check.check_id, existing.kind, check.kind, existing.scope, check.scope
                    ),
                );
            } else {
                dedup_uncertainties.push(UncertaintyReason::BuildProviderFailed(format!(
                    "duplicate identical check '{}' deduplicated",
                    check.check_id
                )));
            }
        } else {
            seen_checks.insert(check.check_id.as_str(), check);
            unique_checks.push(check);
        }
    }

    let mut results: Vec<CheckExecutionResult> = Vec::with_capacity(unique_checks.len());
    let mut invocation_cache: HashMap<(String, Vec<String>, PathBuf), RawProcessOutcome> =
        HashMap::new();
    let mut fail_fast_triggered = false;

    for check in &unique_checks {
        if fail_fast_triggered {
            results.push(CheckExecutionResult {
                check_id: check.check_id.clone(),
                kind: check.kind,
                status: CheckExecutionStatus::Skipped,
                command: vec![],
                cwd: ".".to_string(),
                exit_code: None,
                signal: None,
                duration_ms: 0,
                stdout_digest: None,
                stderr_digest: None,
                stdout_excerpt: None,
                stderr_excerpt: None,
                stdout_captured_bytes: 0,
                stderr_captured_bytes: 0,
                stdout_truncated: false,
                stderr_truncated: false,
                started_at_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                reason: Some("skipped due to fail-fast".to_string()),
            });
            continue;
        }

        // If this check had a conflicting duplicate in the plan, fail closed
        if let Some(err_msg) = conflicting_check_ids.get(&check.check_id) {
            results.push(CheckExecutionResult {
                check_id: check.check_id.clone(),
                kind: check.kind,
                status: CheckExecutionStatus::Unsupported,
                command: vec![],
                cwd: ".".to_string(),
                exit_code: None,
                signal: None,
                duration_ms: 0,
                stdout_digest: None,
                stderr_digest: None,
                stdout_excerpt: None,
                stderr_excerpt: None,
                stdout_captured_bytes: 0,
                stderr_captured_bytes: 0,
                stdout_truncated: false,
                stderr_truncated: false,
                started_at_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                reason: Some(err_msg.clone()),
            });
            if options.fail_fast {
                fail_fast_triggered = true;
            }
            continue;
        }

        let action = resolve_check_action(repo_root, check);
        match action {
            ExecutionAction::Unsupported { reason, .. } => {
                results.push(CheckExecutionResult {
                    check_id: check.check_id.clone(),
                    kind: check.kind,
                    status: CheckExecutionStatus::Unsupported,
                    command: vec![],
                    cwd: ".".to_string(),
                    exit_code: None,
                    signal: None,
                    duration_ms: 0,
                    stdout_digest: None,
                    stderr_digest: None,
                    stdout_excerpt: None,
                    stderr_excerpt: None,
                    stdout_captured_bytes: 0,
                    stderr_captured_bytes: 0,
                    stdout_truncated: false,
                    stderr_truncated: false,
                    started_at_ms: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                    reason: Some(redact_secrets(&reason)),
                });
                if options.fail_fast {
                    fail_fast_triggered = true;
                }
            }
            concrete_action => match concrete_action.to_invocation(repo_root) {
                Ok(inv) => {
                    let cache_key = (inv.program.clone(), inv.argv.clone(), inv.cwd.clone());
                    let raw_outcome = match invocation_cache.get(&cache_key) {
                        Some(cached) => cached.clone(),
                        None => {
                            let outcome = execute_bounded_command(
                                &inv.program,
                                &inv.argv,
                                &inv.cwd,
                                &options.bounds,
                            );
                            invocation_cache.insert(cache_key, outcome.clone());
                            outcome
                        }
                    };

                    let rel_cwd = inv
                        .cwd
                        .strip_prefix(repo_root)
                        .unwrap_or(&inv.cwd)
                        .to_string_lossy()
                        .into_owned();
                    let display_cwd = if rel_cwd.is_empty() {
                        ".".to_string()
                    } else {
                        rel_cwd
                    };

                    let mut full_cmd = vec![inv.program.clone()];
                    full_cmd.extend(inv.argv.clone());

                    let is_failed =
                        raw_outcome.status.is_failure() || raw_outcome.status.is_incomplete();

                    results.push(CheckExecutionResult {
                        check_id: check.check_id.clone(),
                        kind: check.kind,
                        status: raw_outcome.status,
                        command: full_cmd,
                        cwd: display_cwd,
                        exit_code: raw_outcome.exit_code,
                        signal: raw_outcome.signal,
                        duration_ms: raw_outcome.duration_ms,
                        stdout_digest: raw_outcome.stdout_digest,
                        stderr_digest: raw_outcome.stderr_digest,
                        stdout_excerpt: raw_outcome.stdout_excerpt,
                        stderr_excerpt: raw_outcome.stderr_excerpt,
                        stdout_captured_bytes: raw_outcome.stdout_captured_bytes,
                        stderr_captured_bytes: raw_outcome.stderr_captured_bytes,
                        stdout_truncated: raw_outcome.stdout_truncated,
                        stderr_truncated: raw_outcome.stderr_truncated,
                        started_at_ms: raw_outcome.started_at_ms,
                        reason: raw_outcome.reason,
                    });

                    if options.fail_fast && is_failed {
                        fail_fast_triggered = true;
                    }
                }
                Err(err) => {
                    results.push(CheckExecutionResult {
                        check_id: check.check_id.clone(),
                        kind: check.kind,
                        status: CheckExecutionStatus::Unsupported,
                        command: vec![],
                        cwd: ".".to_string(),
                        exit_code: None,
                        signal: None,
                        duration_ms: 0,
                        stdout_digest: None,
                        stderr_digest: None,
                        stdout_excerpt: None,
                        stderr_excerpt: None,
                        stdout_captured_bytes: 0,
                        stderr_captured_bytes: 0,
                        stdout_truncated: false,
                        stderr_truncated: false,
                        started_at_ms: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                        reason: Some(redact_secrets(&err)),
                    });
                    if options.fail_fast {
                        fail_fast_triggered = true;
                    }
                }
            },
        }
    }

    let initial_outcome = aggregate_outcome(plan, &results);
    let (initial_assurance, uncertainties) =
        propagate_assurance(plan, &results, &dedup_uncertainties);
    let duration_ms = start_instant.elapsed().as_millis() as u64;

    let mut verification_run = VerificationRun {
        run_id,
        plan: plan.clone(),
        outcome: initial_outcome,
        assurance: initial_assurance,
        checks: results,
        uncertainty: uncertainties,
        base: options.base.clone(),
        head: options.head.clone(),
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: start_wall,
        duration_ms,
    };

    if options.persist {
        match persist_verification_run(repo_root, &verification_run) {
            Ok(path) => {
                verification_run.persistence_status = PersistenceStatus::Persisted {
                    path: path.to_string_lossy().into_owned(),
                };
            }
            Err(e) => {
                verification_run.persistence_status = PersistenceStatus::Failed {
                    reason: format!("failed to persist verification run: {}", e),
                };
                if verification_run.outcome == VerificationOutcome::Passed {
                    verification_run.outcome = VerificationOutcome::Incomplete;
                }
                verification_run.assurance = AssuranceLevel::Unverified;
                verification_run
                    .uncertainty
                    .push(UncertaintyReason::BuildProviderFailed(format!(
                        "verification run persistence failed: {}",
                        e
                    )));
            }
        }
    }

    Ok(verification_run)
}
