//! Verification result aggregation and assurance propagation.
//!
//! Enforces the M7 assurance contract:
//! 1. execution_assurance <= plan.assurance (never upgrades M6 assurance).
//! 2. If any required check was incomplete (TimedOut, SpawnFailed, Unsupported, Cancelled, Skipped), assurance degrades to Unverified.
//! 3. Outcome precedence: Failed > Incomplete > Passed.
//! 4. Conclusive test failures are valid execution evidence, not uncertainties by themselves.

use crate::intelligence::change::uncertainty::UncertaintyReason;
use crate::intelligence::testplan::model::VerificationPlan;
use crate::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, VerificationOutcome,
};
use crate::protocol::AssuranceLevel;

/// Compute overall verification outcome from individual check results.
pub fn aggregate_outcome(checks: &[CheckExecutionResult]) -> VerificationOutcome {
    if checks.is_empty() {
        return VerificationOutcome::Passed;
    }

    let mut has_failure = false;
    let mut has_incomplete = false;

    for check in checks {
        match check.status {
            CheckExecutionStatus::Failed => {
                has_failure = true;
            }
            CheckExecutionStatus::TimedOut
            | CheckExecutionStatus::SpawnFailed
            | CheckExecutionStatus::Unsupported
            | CheckExecutionStatus::Skipped
            | CheckExecutionStatus::Cancelled => {
                has_incomplete = true;
            }
            CheckExecutionStatus::Passed => {}
            CheckExecutionStatus::Pending | CheckExecutionStatus::Running => {
                has_incomplete = true;
            }
        }
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

    // Never upgrade plan assurance
    let base_assurance = plan.assurance;

    let execution_assurance = if any_incomplete {
        AssuranceLevel::Unverified
    } else {
        base_assurance
    };

    (execution_assurance, uncertainties)
}
