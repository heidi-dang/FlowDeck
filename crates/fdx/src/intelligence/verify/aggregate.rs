//! Verification result aggregation and assurance propagation.
//!
//! Enforces the M7 assurance contract:
//! 1. execution_assurance <= plan.assurance (never upgrades M6 assurance).
//! 2. If any required check was incomplete (TimedOut, OutputLimitExceeded, SpawnFailed, Unsupported, Cancelled, Skipped) or unresolved obligations remain, assurance degrades to Unverified.
//! 3. Outcome precedence: Failed > Incomplete > Passed.
//! 4. Conclusive test failures are valid execution evidence, not uncertainties by themselves.

use crate::intelligence::change::uncertainty::UncertaintyReason;
use crate::intelligence::testplan::model::VerificationPlan;
use crate::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, VerificationOutcome,
};
use crate::protocol::AssuranceLevel;

/// Compute overall verification outcome from the plan and individual check results.
pub fn aggregate_outcome(
    plan: &VerificationPlan,
    checks: &[CheckExecutionResult],
) -> VerificationOutcome {
    let mut has_failure = false;
    let mut has_incomplete = false;

    for check in checks {
        match check.status {
            CheckExecutionStatus::Failed => {
                has_failure = true;
            }
            CheckExecutionStatus::TimedOut
            | CheckExecutionStatus::OutputLimitExceeded
            | CheckExecutionStatus::SpawnFailed
            | CheckExecutionStatus::Unsupported
            | CheckExecutionStatus::Skipped
            | CheckExecutionStatus::Cancelled
            | CheckExecutionStatus::Pending
            | CheckExecutionStatus::Running => {
                has_incomplete = true;
            }
            CheckExecutionStatus::Passed => {}
        }
    }

    // Unresolved obligations from M6 plan prevent Passed outcome
    if !plan.unresolved_obligations.is_empty() {
        has_incomplete = true;
    }

    // Precedence: Failed takes precedence for outcome reporting, while retaining incompleteness in assurance/diagnostics.
    if has_failure {
        VerificationOutcome::Failed
    } else if has_incomplete {
        VerificationOutcome::Incomplete
    } else {
        VerificationOutcome::Passed
    }
}

/// Compute the effective execution assurance level, bounded by plan assurance.
pub fn propagate_assurance(
    plan: &VerificationPlan,
    checks: &[CheckExecutionResult],
    extra_uncertainties: &[UncertaintyReason],
) -> (AssuranceLevel, Vec<UncertaintyReason>) {
    let mut uncertainties = plan.uncertainty.clone();
    uncertainties.extend_from_slice(extra_uncertainties);

    let mut any_incomplete = false;
    for check in checks {
        if check.status.is_incomplete() {
            any_incomplete = true;
            if let Some(ref reason) = check.reason {
                uncertainties.push(UncertaintyReason::BuildProviderFailed(format!(
                    "check '{}' incomplete: {}",
                    check.check_id, reason
                )));
            }
        }
    }

    if !plan.unresolved_obligations.is_empty() {
        any_incomplete = true;
        for uo in &plan.unresolved_obligations {
            uncertainties.push(UncertaintyReason::BuildProviderFailed(format!(
                "unresolved obligation in scope '{}': {} (source: {})",
                uo.scope, uo.reason, uo.source
            )));
        }
    }

    // Never upgrade plan assurance
    let base_assurance = plan.assurance;

    let execution_assurance = if any_incomplete {
        AssuranceLevel::Unverified
    } else {
        base_assurance
    };

    (execution_assurance, uncertainties)
}
