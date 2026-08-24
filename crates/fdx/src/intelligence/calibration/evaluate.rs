//! Shadow calibration execution and evaluation engine.

use crate::intelligence::calibration::model::*;
use crate::intelligence::calibration::policy::{compute_policy_digest, generate_calibration_id};
use crate::intelligence::calibration::reference::construct_shadow_reference_set;
use crate::intelligence::runtime::compute_plan_digest;
use crate::intelligence::schema::CURRENT_SCHEMA_VERSION;
use crate::intelligence::verify::action::ExecutionAction;
use crate::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, VerificationRun,
};
use crate::intelligence::verify::process::{
    execute_bounded_command, ProcessBounds, RawProcessOutcome,
};
use crate::intelligence::verify::redact::redact_secrets;
use crate::intelligence::verify::resolve::resolve_check_action;
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Execute shadow calibration for a given source verification run and bounding policy.
pub fn run_calibration(
    repo_root: &Path,
    source_run: &VerificationRun,
    policy: &CalibrationPolicy,
) -> Result<CalibrationRun, String> {
    let start_wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let start_instant = Instant::now();

    // 1. Cryptographic digests and identifiers
    let candidate_plan_digest = compute_plan_digest(&source_run.plan)?;
    let policy_digest = compute_policy_digest(policy)?;
    let calibration_id = generate_calibration_id(
        &source_run.run_id,
        &candidate_plan_digest,
        &policy_digest,
        CURRENT_SCHEMA_VERSION,
    );

    // 2. Construct deterministic shadow reference set
    let (reference_checks, reference_truncated) =
        construct_shadow_reference_set(repo_root, &source_run.plan, policy);

    // 3. Map candidate execution results by check_id for safe reuse
    let mut candidate_results_map: HashMap<&str, &CheckExecutionResult> = HashMap::new();
    for res in &source_run.checks {
        candidate_results_map.insert(res.check_id.as_str(), res);
    }

    let mut shadow_checks: Vec<ShadowCheckObservation> = Vec::with_capacity(reference_checks.len());
    let mut shadow_executions: Vec<ShadowExecutionObservation> = Vec::new();
    let mut invocation_cache: HashMap<
        (String, Vec<String>, std::path::PathBuf),
        RawProcessOutcome,
    > = HashMap::new();

    let mut time_budget_exhausted = false;

    for check in &reference_checks {
        let is_candidate_selected = source_run
            .plan
            .selected_checks
            .iter()
            .any(|c| c.check_id == check.check_id);

        if let Some(candidate_res) = candidate_results_map.get(check.check_id.as_str()) {
            // Reused existing M7 execution outcome from source run
            let signal_class = match candidate_res.status {
                CheckExecutionStatus::Passed => SignalClass::SelectedPass,
                CheckExecutionStatus::Failed => SignalClass::SelectedSignal,
                _ => SignalClass::Incomplete,
            };

            let is_observed_shadow_miss = false; // Candidate-selected checks are never shadow misses

            shadow_checks.push(ShadowCheckObservation {
                check_id: check.check_id.clone(),
                display_name: check.display_name.clone(),
                kind: check.kind,
                scope: check.scope.clone(),
                candidate_selected: true,
                reference_selected: true,
                execution_status: candidate_res.status,
                has_physical_execution: !candidate_res.command.is_empty()
                    && candidate_res.duration_ms > 0,
                duration_ms: candidate_res.duration_ms,
                signal_class,
                is_observed_shadow_miss,
                reason: candidate_res.reason.clone(),
            });

            shadow_executions.push(ShadowExecutionObservation {
                execution_id: format!("shadow_{}", candidate_res.execution_id),
                check_id: check.check_id.clone(),
                program: candidate_res.command.first().cloned().unwrap_or_default(),
                argv_digest: crate::intelligence::runtime::compute_argv_digest(
                    &candidate_res.command,
                ),
                cwd: candidate_res.cwd.clone(),
                status: candidate_res.status,
                exit_code: candidate_res.exit_code,
                duration_ms: candidate_res.duration_ms,
                stdout_digest: candidate_res.stdout_digest.clone(),
                stderr_digest: candidate_res.stderr_digest.clone(),
            });
        } else {
            // Check was not selected in candidate plan: execute independently under shadow bounds
            if !time_budget_exhausted
                && start_instant.elapsed().as_millis() as u64 >= policy.max_total_duration_ms
            {
                time_budget_exhausted = true;
            }

            if time_budget_exhausted {
                shadow_checks.push(ShadowCheckObservation {
                    check_id: check.check_id.clone(),
                    display_name: check.display_name.clone(),
                    kind: check.kind,
                    scope: check.scope.clone(),
                    candidate_selected: false,
                    reference_selected: true,
                    execution_status: CheckExecutionStatus::Cancelled,
                    has_physical_execution: false,
                    duration_ms: 0,
                    signal_class: SignalClass::Incomplete,
                    is_observed_shadow_miss: false,
                    reason: Some("Calibration time budget exhausted".to_string()),
                });
                continue;
            }

            let resolved_action = resolve_check_action(repo_root, check);
            match resolved_action {
                ExecutionAction::Unsupported { reason, .. } => {
                    shadow_checks.push(ShadowCheckObservation {
                        check_id: check.check_id.clone(),
                        display_name: check.display_name.clone(),
                        kind: check.kind,
                        scope: check.scope.clone(),
                        candidate_selected: false,
                        reference_selected: true,
                        execution_status: CheckExecutionStatus::Unsupported,
                        has_physical_execution: false,
                        duration_ms: 0,
                        signal_class: SignalClass::Incomplete,
                        is_observed_shadow_miss: false,
                        reason: Some(redact_secrets(&reason)),
                    });
                }
                concrete_action => match concrete_action.to_invocation(repo_root) {
                    Err(e) => {
                        shadow_checks.push(ShadowCheckObservation {
                            check_id: check.check_id.clone(),
                            display_name: check.display_name.clone(),
                            kind: check.kind,
                            scope: check.scope.clone(),
                            candidate_selected: false,
                            reference_selected: true,
                            execution_status: CheckExecutionStatus::Unsupported,
                            has_physical_execution: false,
                            duration_ms: 0,
                            signal_class: SignalClass::Incomplete,
                            is_observed_shadow_miss: false,
                            reason: Some(redact_secrets(&e)),
                        });
                    }
                    Ok(inv) => {
                        let mut full_cmd = vec![inv.program.clone()];
                        full_cmd.extend(inv.argv.clone());

                        let cache_key = (inv.program.clone(), inv.argv.clone(), inv.cwd.clone());
                        let outcome = if let Some(cached) = invocation_cache.get(&cache_key) {
                            cached.clone()
                        } else {
                            let process_bounds = ProcessBounds {
                                timeout: Duration::from_millis(policy.per_check_timeout_ms),
                                max_stdout_bytes: policy.max_output_bytes as u64,
                                max_stderr_bytes: policy.max_output_bytes as u64,
                                tail_limit_bytes: 8 * 1024,
                            };
                            let out = execute_bounded_command(
                                &inv.program,
                                &inv.argv,
                                &inv.cwd,
                                &process_bounds,
                            );
                            invocation_cache.insert(cache_key, out.clone());
                            out
                        };

                        let has_physical = matches!(
                            outcome.status,
                            CheckExecutionStatus::Passed
                                | CheckExecutionStatus::Failed
                                | CheckExecutionStatus::TimedOut
                                | CheckExecutionStatus::OutputLimitExceeded
                        );

                        let signal_class = match outcome.status {
                            CheckExecutionStatus::Passed => {
                                if is_candidate_selected {
                                    SignalClass::SelectedPass
                                } else {
                                    SignalClass::UnselectedPass
                                }
                            }
                            CheckExecutionStatus::Failed => {
                                if is_candidate_selected {
                                    SignalClass::SelectedSignal
                                } else if has_physical {
                                    SignalClass::ObservedShadowMiss
                                } else {
                                    SignalClass::Incomplete
                                }
                            }
                            _ => SignalClass::Incomplete,
                        };

                        let is_observed_shadow_miss =
                            signal_class == SignalClass::ObservedShadowMiss;

                        let exec_id = format!(
                            "shadow_exec_{}_{}",
                            check.check_id.replace([':', '/'], "_"),
                            shadow_executions.len() + 1
                        );

                        shadow_checks.push(ShadowCheckObservation {
                            check_id: check.check_id.clone(),
                            display_name: check.display_name.clone(),
                            kind: check.kind,
                            scope: check.scope.clone(),
                            candidate_selected: is_candidate_selected,
                            reference_selected: true,
                            execution_status: outcome.status,
                            has_physical_execution: has_physical,
                            duration_ms: outcome.duration_ms,
                            signal_class,
                            is_observed_shadow_miss,
                            reason: outcome.reason.clone(),
                        });

                        shadow_executions.push(ShadowExecutionObservation {
                            execution_id: exec_id,
                            check_id: check.check_id.clone(),
                            program: inv.program,
                            argv_digest: crate::intelligence::runtime::compute_argv_digest(
                                &full_cmd,
                            ),
                            cwd: inv.cwd.to_string_lossy().to_string(),
                            status: outcome.status,
                            exit_code: outcome.exit_code,
                            duration_ms: outcome.duration_ms,
                            stdout_digest: outcome.stdout_digest,
                            stderr_digest: outcome.stderr_digest,
                        });
                    }
                },
            }
        }
    }

    // 4. Compute metrics
    let candidate_selected_count = shadow_checks
        .iter()
        .filter(|c| c.candidate_selected)
        .count();
    let shadow_reference_count = shadow_checks.len();
    let shadow_executed_count = shadow_checks
        .iter()
        .filter(|c| c.execution_status.is_terminal())
        .count();
    let selected_failure_count = shadow_checks
        .iter()
        .filter(|c| c.signal_class == SignalClass::SelectedSignal)
        .count();
    let unselected_failure_count = shadow_checks
        .iter()
        .filter(|c| c.signal_class == SignalClass::ObservedShadowMiss)
        .count();
    let observed_shadow_miss_count = unselected_failure_count;
    let shadow_incomplete_count = shadow_checks
        .iter()
        .filter(|c| c.signal_class == SignalClass::Incomplete)
        .count();

    let candidate_execution_duration_ms: u64 = shadow_checks
        .iter()
        .filter(|c| c.candidate_selected)
        .map(|c| c.duration_ms)
        .sum();

    let shadow_reference_duration_ms: u64 = shadow_checks.iter().map(|c| c.duration_ms).sum();

    let selection_ratio = if shadow_reference_count > 0 {
        Some(candidate_selected_count as f64 / shadow_reference_count as f64)
    } else {
        None
    };

    let runtime_cost_ratio = if shadow_reference_duration_ms > 0 {
        Some(candidate_execution_duration_ms as f64 / shadow_reference_duration_ms as f64)
    } else {
        None
    };

    let total_failing_signals = selected_failure_count + unselected_failure_count;
    let signal_recall = if total_failing_signals > 0 {
        Some(selected_failure_count as f64 / total_failing_signals as f64)
    } else {
        None // NEVER report 100% when no failing signal existed
    };

    let eligibility = CalibrationEligibility {
        eligible_for_miss_rate: shadow_incomplete_count == 0 && !reference_truncated,
        eligible_for_cost_ratio: shadow_executed_count > 0
            && candidate_execution_duration_ms > 0
            && shadow_reference_duration_ms > 0,
        eligible_for_runtime_comparison: shadow_executed_count > 0
            && shadow_incomplete_count == 0
            && !reference_truncated,
    };

    let status = if shadow_incomplete_count == 0 && !reference_truncated {
        CalibrationStatus::Complete
    } else {
        CalibrationStatus::Incomplete
    };

    let completed_wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let total_duration_ms = start_instant.elapsed().as_millis() as u64;

    let metrics = CalibrationMetrics {
        candidate_selected_count,
        shadow_reference_count,
        shadow_executed_count,
        selected_failure_count,
        unselected_failure_count,
        observed_shadow_miss_count,
        shadow_incomplete_count,
        candidate_execution_duration_ms,
        shadow_reference_duration_ms,
        selection_ratio,
        runtime_cost_ratio,
        signal_recall,
        eligibility,
    };

    Ok(CalibrationRun {
        calibration_id,
        source_run_id: source_run.run_id.clone(),
        candidate_plan_digest,
        policy: policy.clone(),
        policy_digest,
        status,
        reference_truncated,
        candidate_plan: source_run.plan.clone(),
        checks: shadow_checks,
        executions: shadow_executions,
        metrics,
        started_at_ms: start_wall,
        completed_at_ms: completed_wall,
        duration_ms: total_duration_ms,
    })
}
