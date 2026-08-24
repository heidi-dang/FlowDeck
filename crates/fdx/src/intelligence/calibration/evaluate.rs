//! Shadow calibration execution and evaluation engine.

use crate::intelligence::attestation::canonical::compute_canonical_sha256;
use crate::intelligence::calibration::model::*;
use crate::intelligence::calibration::policy::{compute_policy_digest, generate_calibration_id};
use crate::intelligence::calibration::reference::construct_shadow_reference_set;
use crate::intelligence::runtime::{
    compute_argv_digest, compute_plan_digest, is_physical_process_execution, sha256_bytes,
};
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
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static PROJECT_SECRET_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bsk-proj-[A-Za-z0-9_-]+\b").expect("valid project secret regex")
});
static USER_HOME_PATH_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:/home|/Users)/[^\s\"']+"#).expect("valid user home path regex")
});

#[derive(Clone)]
struct CachedShadowExecution {
    outcome: RawProcessOutcome,
    execution_id: Option<String>,
}

#[derive(Serialize)]
struct CalibrationRecordDigestInput<'a> {
    calibration_contract_version: u32,
    source_run_id: &'a str,
    source_artifact_sha256: &'a str,
    candidate_plan_digest: &'a str,
    policy_digest: &'a str,
    status: CalibrationStatus,
    reference_truncated: bool,
    checks: &'a [ShadowCheckObservation],
    executions: &'a [ShadowExecutionObservation],
    metrics: &'a CalibrationMetrics,
}

/// Compute the digest of semantic calibration evidence. Timestamps are intentionally excluded:
/// they are operational metadata, not calibration evidence.
pub fn compute_calibration_record_digest(run: &CalibrationRun) -> Result<String, String> {
    compute_canonical_sha256(&CalibrationRecordDigestInput {
        calibration_contract_version: run.calibration_contract_version,
        source_run_id: &run.source_run_id,
        source_artifact_sha256: &run.source_artifact_sha256,
        candidate_plan_digest: &run.candidate_plan_digest,
        policy_digest: &run.policy_digest,
        status: run.status,
        reference_truncated: run.reference_truncated,
        checks: &run.checks,
        executions: &run.executions,
        metrics: &run.metrics,
    })
}

/// Execute shadow calibration using a deterministic digest of the serialized source run. The CLI
/// uses `run_calibration_with_source_artifact` so persisted records bind exact artifact bytes.
pub fn run_calibration(
    repo_root: &Path,
    source_run: &VerificationRun,
    policy: &CalibrationPolicy,
) -> Result<CalibrationRun, String> {
    let serialized = serde_json::to_vec(source_run)
        .map_err(|e| format!("cannot serialize source verification run for calibration: {e}"))?;
    run_calibration_with_source_artifact(repo_root, source_run, policy, &sha256_bytes(&serialized))
}

/// Execute shadow calibration while binding the exact source M7 artifact hash.
pub fn run_calibration_with_source_artifact(
    repo_root: &Path,
    source_run: &VerificationRun,
    policy: &CalibrationPolicy,
    source_artifact_sha256: &str,
) -> Result<CalibrationRun, String> {
    if source_artifact_sha256.trim().is_empty() {
        return Err("calibration requires a non-empty source artifact SHA-256".to_string());
    }

    let start_wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let start_instant = Instant::now();

    let candidate_plan_digest = compute_plan_digest(&source_run.plan)?;
    let policy_digest = compute_policy_digest(policy)?;
    let calibration_id = generate_calibration_id(
        &source_run.run_id,
        &candidate_plan_digest,
        &policy_digest,
        CURRENT_SCHEMA_VERSION,
    );

    validate_source_relationship(source_run)?;
    let (reference_checks, reference_truncated) =
        construct_shadow_reference_set(repo_root, &source_run.plan, policy);
    validate_reference_superset(&source_run.plan, &reference_checks)?;

    let candidate_results: HashMap<&str, &CheckExecutionResult> = source_run
        .checks
        .iter()
        .map(|result| (result.check_id.as_str(), result))
        .collect();

    let mut shadow_checks = Vec::with_capacity(reference_checks.len());
    let mut shadow_executions = Vec::new();
    let mut candidate_execution_ids = HashSet::new();
    let mut shadow_execution_ids = HashSet::new();
    let mut seen_candidate_executions = HashSet::new();
    let mut invocation_cache: HashMap<(String, Vec<String>, PathBuf), CachedShadowExecution> =
        HashMap::new();

    for check in &reference_checks {
        if let Some(candidate_res) = candidate_results.get(check.check_id.as_str()) {
            let has_physical_execution = is_physical_process_execution(&candidate_res.status);
            let execution_id = has_physical_execution
                .then(|| format!("candidate_{}", candidate_res.execution_id.trim()));
            let reused_execution = has_physical_execution && candidate_res.reused_execution;

            if let Some(execution_id) = &execution_id {
                candidate_execution_ids.insert(execution_id.clone());
                if seen_candidate_executions.insert(execution_id.clone()) {
                    shadow_executions.push(ShadowExecutionObservation {
                        execution_id: execution_id.clone(),
                        check_id: check.check_id.clone(),
                        origin: CalibrationExecutionOrigin::CandidateSource,
                        program: safe_program(candidate_res.command.first().map(String::as_str)),
                        argv_digest: compute_argv_digest(&candidate_res.command),
                        cwd: safe_source_cwd(repo_root, &candidate_res.cwd)?,
                        status: candidate_res.status,
                        exit_code: candidate_res.exit_code,
                        duration_ms: candidate_res.duration_ms,
                        stdout_digest: candidate_res.stdout_digest.clone(),
                        stderr_digest: candidate_res.stderr_digest.clone(),
                    });
                }
            }

            shadow_checks.push(ShadowCheckObservation {
                check_id: check.check_id.clone(),
                display_name: check.display_name.clone(),
                kind: check.kind,
                scope: check.scope.clone(),
                candidate_selected: true,
                reference_selected: true,
                execution_status: candidate_res.status,
                has_physical_execution,
                execution_id,
                reused_execution,
                duration_ms: candidate_res.duration_ms,
                signal_class: candidate_signal_class(candidate_res.status),
                is_observed_shadow_miss: false,
                reason: candidate_res.reason.as_deref().map(redact_calibration_text),
            });
            continue;
        }

        let elapsed_ms = start_instant.elapsed().as_millis() as u64;
        let remaining_ms = policy.max_total_duration_ms.saturating_sub(elapsed_ms);
        if remaining_ms == 0 {
            shadow_checks.push(incomplete_observation(
                check,
                "Calibration time budget exhausted",
            ));
            continue;
        }

        match resolve_check_action(repo_root, check) {
            ExecutionAction::Unsupported { reason, .. } => {
                shadow_checks.push(unsupported_observation(check, reason));
            }
            concrete_action => match concrete_action.to_invocation(repo_root) {
                Err(error) => shadow_checks.push(unsupported_observation(check, error)),
                Ok(invocation) => {
                    let key = (
                        invocation.program.clone(),
                        invocation.argv.clone(),
                        invocation.cwd.clone(),
                    );
                    let cached = if let Some(existing) = invocation_cache.get(&key) {
                        existing.clone()
                    } else {
                        let effective_timeout_ms = policy.per_check_timeout_ms.min(remaining_ms);
                        let bounds = ProcessBounds {
                            timeout: Duration::from_millis(effective_timeout_ms),
                            max_stdout_bytes: policy.max_output_bytes as u64,
                            max_stderr_bytes: policy.max_output_bytes as u64,
                            tail_limit_bytes: 8 * 1024,
                        };
                        let outcome = execute_bounded_command(
                            &invocation.program,
                            &invocation.argv,
                            &invocation.cwd,
                            &bounds,
                        );
                        let has_physical_execution = is_physical_process_execution(&outcome.status);
                        let execution_id = has_physical_execution
                            .then(|| format!("shadow_exec_{:04}", shadow_executions.len() + 1));
                        if let Some(execution_id) = &execution_id {
                            let mut full_command = vec![invocation.program.clone()];
                            full_command.extend(invocation.argv.clone());
                            shadow_executions.push(ShadowExecutionObservation {
                                execution_id: execution_id.clone(),
                                check_id: check.check_id.clone(),
                                origin: CalibrationExecutionOrigin::ShadowReference,
                                program: safe_program(Some(&invocation.program)),
                                argv_digest: compute_argv_digest(&full_command),
                                cwd: safe_invocation_cwd(repo_root, &invocation.cwd)?,
                                status: outcome.status,
                                exit_code: outcome.exit_code,
                                duration_ms: outcome.duration_ms,
                                stdout_digest: outcome.stdout_digest.clone(),
                                stderr_digest: outcome.stderr_digest.clone(),
                            });
                        }
                        let value = CachedShadowExecution {
                            outcome,
                            execution_id,
                        };
                        invocation_cache.insert(key, value.clone());
                        value
                    };

                    let has_physical_execution =
                        is_physical_process_execution(&cached.outcome.status);
                    let reused_execution = cached.execution_id.is_some()
                        && shadow_checks
                            .iter()
                            .any(|observation: &ShadowCheckObservation| {
                                observation.execution_id == cached.execution_id
                            });
                    if let Some(execution_id) = &cached.execution_id {
                        shadow_execution_ids.insert(execution_id.clone());
                    }
                    let signal_class =
                        shadow_signal_class(cached.outcome.status, has_physical_execution);
                    shadow_checks.push(ShadowCheckObservation {
                        check_id: check.check_id.clone(),
                        display_name: check.display_name.clone(),
                        kind: check.kind,
                        scope: check.scope.clone(),
                        candidate_selected: false,
                        reference_selected: true,
                        execution_status: cached.outcome.status,
                        has_physical_execution,
                        execution_id: cached.execution_id,
                        reused_execution,
                        duration_ms: cached.outcome.duration_ms,
                        signal_class,
                        is_observed_shadow_miss: signal_class == SignalClass::ObservedShadowMiss,
                        reason: cached
                            .outcome
                            .reason
                            .as_deref()
                            .map(redact_calibration_text),
                    });
                }
            },
        }
    }

    let candidate_selected_count = shadow_checks
        .iter()
        .filter(|check| check.candidate_selected)
        .count();
    let shadow_reference_count = shadow_checks.len();
    let candidate_physical_execution_count = candidate_execution_ids.len();
    let shadow_physical_execution_count = shadow_execution_ids.len();
    let selected_failure_count = shadow_checks
        .iter()
        .filter(|check| check.signal_class == SignalClass::SelectedSignal)
        .count();
    let observed_shadow_miss_count = shadow_checks
        .iter()
        .filter(|check| check.signal_class == SignalClass::ObservedShadowMiss)
        .count();
    let shadow_incomplete_count = shadow_checks
        .iter()
        .filter(|check| check.signal_class == SignalClass::Incomplete)
        .count();

    let candidate_execution_duration_ms = shadow_executions
        .iter()
        .filter(|execution| execution.origin == CalibrationExecutionOrigin::CandidateSource)
        .map(|execution| execution.duration_ms)
        .sum();
    let shadow_reference_duration_ms = shadow_executions
        .iter()
        .map(|execution| execution.duration_ms)
        .sum();
    let selection_ratio = (shadow_reference_count > 0)
        .then(|| candidate_selected_count as f64 / shadow_reference_count as f64);
    let runtime_cost_ratio = (shadow_reference_duration_ms > 0)
        .then(|| candidate_execution_duration_ms as f64 / shadow_reference_duration_ms as f64);
    let complete_reference = shadow_incomplete_count == 0 && !reference_truncated;
    let total_failing_signals = selected_failure_count + observed_shadow_miss_count;
    let signal_recall = (complete_reference && total_failing_signals > 0)
        .then(|| selected_failure_count as f64 / total_failing_signals as f64);
    let status = if complete_reference {
        CalibrationStatus::Complete
    } else {
        CalibrationStatus::Incomplete
    };
    let eligibility = CalibrationEligibility {
        eligible_for_miss_rate: complete_reference,
        eligible_for_cost_ratio: complete_reference && shadow_reference_duration_ms > 0,
        eligible_for_runtime_comparison: complete_reference && shadow_physical_execution_count > 0,
    };
    let metrics = CalibrationMetrics {
        candidate_selected_count,
        shadow_reference_count,
        shadow_executed_count: shadow_physical_execution_count,
        candidate_physical_execution_count,
        shadow_physical_execution_count,
        selected_failure_count,
        unselected_failure_count: observed_shadow_miss_count,
        observed_shadow_miss_count,
        shadow_incomplete_count,
        candidate_execution_duration_ms,
        shadow_reference_duration_ms,
        selection_ratio,
        runtime_cost_ratio,
        signal_recall,
        eligibility,
    };

    let completed_wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let duration_ms = start_instant.elapsed().as_millis() as u64;
    let mut calibration = CalibrationRun {
        calibration_id,
        calibration_contract_version: CALIBRATION_CONTRACT_VERSION,
        source_run_id: source_run.run_id.clone(),
        source_artifact_sha256: source_artifact_sha256.to_string(),
        candidate_plan_digest,
        policy: policy.clone(),
        policy_digest,
        status,
        reference_truncated,
        candidate_plan: source_run.plan.clone(),
        checks: shadow_checks,
        executions: shadow_executions,
        metrics,
        record_digest: String::new(),
        started_at_ms: start_wall,
        completed_at_ms: completed_wall,
        duration_ms,
    };
    calibration.record_digest = compute_calibration_record_digest(&calibration)?;
    Ok(calibration)
}

fn validate_reference_superset(
    plan: &crate::intelligence::testplan::model::VerificationPlan,
    reference: &[crate::intelligence::testplan::model::PlannedCheck],
) -> Result<(), String> {
    let ids: HashSet<&str> = reference
        .iter()
        .map(|check| check.check_id.as_str())
        .collect();
    if let Some(missing) = plan
        .selected_checks
        .iter()
        .find(|check| !ids.contains(check.check_id.as_str()))
    {
        return Err(format!(
            "shadow reference invariant failed: candidate check '{}' is missing",
            missing.check_id
        ));
    }
    Ok(())
}

fn validate_source_relationship(source_run: &VerificationRun) -> Result<(), String> {
    let planned: HashSet<&str> = source_run
        .plan
        .selected_checks
        .iter()
        .map(|check| check.check_id.as_str())
        .collect();
    if planned.len() != source_run.plan.selected_checks.len() {
        return Err("source verification plan contains duplicate selected check IDs".to_string());
    }
    let mut observed = HashSet::new();
    let mut execution_groups: HashMap<&str, Vec<&CheckExecutionResult>> = HashMap::new();
    for result in &source_run.checks {
        if !planned.contains(result.check_id.as_str()) {
            return Err(format!(
                "source verification result '{}' is absent from candidate plan",
                result.check_id
            ));
        }
        if !observed.insert(result.check_id.as_str()) {
            return Err(format!(
                "source verification run contains duplicate result for '{}'",
                result.check_id
            ));
        }
        if result.execution_id.trim().is_empty() {
            return Err(format!(
                "source verification result '{}' has an empty execution ID",
                result.check_id
            ));
        }
        execution_groups
            .entry(result.execution_id.as_str())
            .or_default()
            .push(result);
    }
    if let Some(missing) = planned
        .iter()
        .find(|check_id| !observed.contains(**check_id))
    {
        return Err(format!(
            "source verification run lacks a result for candidate check '{}'",
            missing
        ));
    }
    for (execution_id, group) in execution_groups {
        let first = group[0];
        let physical = is_physical_process_execution(&first.status);
        if group
            .iter()
            .any(|result| is_physical_process_execution(&result.status) != physical)
        {
            return Err(format!(
                "source execution '{}' mixes physical and non-physical results",
                execution_id
            ));
        }
        if group
            .iter()
            .filter(|result| !result.reused_execution)
            .count()
            != 1
        {
            return Err(format!(
                "source execution '{}' must have exactly one primary obligation",
                execution_id
            ));
        }
        if group.iter().skip(1).any(|result| {
            result.status != first.status
                || result.command != first.command
                || result.cwd != first.cwd
                || result.exit_code != first.exit_code
                || result.duration_ms != first.duration_ms
                || result.stdout_digest != first.stdout_digest
                || result.stderr_digest != first.stderr_digest
        }) {
            return Err(format!(
                "source execution '{}' has inconsistent shared evidence",
                execution_id
            ));
        }
    }
    Ok(())
}

fn candidate_signal_class(status: CheckExecutionStatus) -> SignalClass {
    match status {
        CheckExecutionStatus::Passed => SignalClass::SelectedPass,
        CheckExecutionStatus::Failed => SignalClass::SelectedSignal,
        _ => SignalClass::Incomplete,
    }
}

fn shadow_signal_class(status: CheckExecutionStatus, physical: bool) -> SignalClass {
    match status {
        CheckExecutionStatus::Passed if physical => SignalClass::UnselectedPass,
        CheckExecutionStatus::Failed if physical => SignalClass::ObservedShadowMiss,
        _ => SignalClass::Incomplete,
    }
}

fn incomplete_observation(
    check: &crate::intelligence::testplan::model::PlannedCheck,
    reason: &str,
) -> ShadowCheckObservation {
    ShadowCheckObservation {
        check_id: check.check_id.clone(),
        display_name: check.display_name.clone(),
        kind: check.kind,
        scope: check.scope.clone(),
        candidate_selected: false,
        reference_selected: true,
        execution_status: CheckExecutionStatus::Cancelled,
        has_physical_execution: false,
        execution_id: None,
        reused_execution: false,
        duration_ms: 0,
        signal_class: SignalClass::Incomplete,
        is_observed_shadow_miss: false,
        reason: Some(redact_calibration_text(reason)),
    }
}

fn unsupported_observation(
    check: &crate::intelligence::testplan::model::PlannedCheck,
    reason: impl AsRef<str>,
) -> ShadowCheckObservation {
    ShadowCheckObservation {
        check_id: check.check_id.clone(),
        display_name: check.display_name.clone(),
        kind: check.kind,
        scope: check.scope.clone(),
        candidate_selected: false,
        reference_selected: true,
        execution_status: CheckExecutionStatus::Unsupported,
        has_physical_execution: false,
        execution_id: None,
        reused_execution: false,
        duration_ms: 0,
        signal_class: SignalClass::Incomplete,
        is_observed_shadow_miss: false,
        reason: Some(redact_calibration_text(reason.as_ref())),
    }
}

fn safe_program(program: Option<&str>) -> String {
    let raw = program.unwrap_or_default();
    let path = Path::new(raw);
    if path.is_absolute() {
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("[redacted-program]")
            .to_string()
    } else {
        redact_calibration_text(raw)
    }
}

fn redact_calibration_text(input: &str) -> String {
    let standard = redact_secrets(input);
    let without_project_secret = PROJECT_SECRET_REGEX
        .replace_all(&standard, "sk-proj-[REDACTED]")
        .into_owned();
    USER_HOME_PATH_REGEX
        .replace_all(&without_project_secret, "[REDACTED USER PATH]")
        .into_owned()
}

fn safe_source_cwd(repo_root: &Path, cwd: &str) -> Result<String, String> {
    let path = Path::new(cwd);
    if path.is_absolute() {
        return safe_invocation_cwd(repo_root, path);
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!(
            "candidate execution cwd escapes repository: {}",
            redact_secrets(cwd)
        ));
    }
    let normalized = path.to_string_lossy();
    Ok(if normalized.is_empty() || normalized == "." {
        ".".to_string()
    } else {
        normalized.to_string()
    })
}

fn safe_invocation_cwd(repo_root: &Path, cwd: &Path) -> Result<String, String> {
    let relative = cwd.strip_prefix(repo_root).map_err(|_| {
        "shadow execution cwd is outside the repository and cannot be persisted".to_string()
    })?;
    let value = relative.to_string_lossy();
    Ok(if value.is_empty() {
        ".".to_string()
    } else {
        value.to_string()
    })
}
