//! Core data structures for Milestone 7: Verification Executor.

use crate::intelligence::change::uncertainty::UncertaintyReason;
use crate::intelligence::testplan::model::{VerificationCheckKind, VerificationPlan};
use crate::protocol::AssuranceLevel;
use serde::{Deserialize, Serialize};

/// Execution status of an individual verification check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckExecutionStatus {
    Pending,
    Running,
    Passed,
    Failed,
    TimedOut,
    OutputLimitExceeded,
    SpawnFailed,
    Unsupported,
    Skipped,
    Cancelled,
}

impl CheckExecutionStatus {
    pub fn is_terminal(&self) -> bool {
        !matches!(self, Self::Pending | Self::Running)
    }

    pub fn is_success(&self) -> bool {
        matches!(self, Self::Passed)
    }

    pub fn is_failure(&self) -> bool {
        matches!(self, Self::Failed)
    }

    pub fn is_incomplete(&self) -> bool {
        matches!(
            self,
            Self::TimedOut
                | Self::OutputLimitExceeded
                | Self::SpawnFailed
                | Self::Unsupported
                | Self::Cancelled
                | Self::Skipped
        )
    }
}

/// Precise execution result and evidence for a single verification check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckExecutionResult {
    /// Stable identifier matching the planned check.
    pub check_id: String,
    /// Kind of verification check.
    pub kind: VerificationCheckKind,
    /// Final execution status.
    pub status: CheckExecutionStatus,
    /// Underlying process execution identity.
    pub execution_id: String,
    /// Whether this check reused the results of an earlier identical execution invocation.
    pub reused_execution: bool,
    /// Authoritative argv command vector executed (never shell-interpolated string).
    pub command: Vec<String>,
    /// Relative or canonical execution working directory strictly contained within repo.
    pub cwd: String,
    /// Process exit code if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Termination signal name if killed by signal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    /// Execution duration in milliseconds.
    pub duration_ms: u64,
    /// SHA256 hex digest of captured stdout prefix under executor bound.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_digest: Option<String>,
    /// SHA256 hex digest of captured stderr prefix under executor bound.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_digest: Option<String>,
    /// Bounded, redacted stdout tail/excerpt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_excerpt: Option<String>,
    /// Bounded, redacted stderr tail/excerpt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_excerpt: Option<String>,
    /// Total captured stdout bytes under executor bound.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub stdout_captured_bytes: u64,
    /// Total captured stderr bytes under executor bound.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub stderr_captured_bytes: u64,
    /// Whether stdout exceeded buffer limit and was truncated.
    pub stdout_truncated: bool,
    /// Whether stderr exceeded buffer limit and was truncated.
    pub stderr_truncated: bool,
    /// Epoch timestamp when execution started.
    pub started_at_ms: u64,
    /// Detailed diagnostic reason if check failed, timed out, or was unsupported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

/// Artifact persistence status for a verification run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum PersistenceStatus {
    NotRequested,
    Persisted { path: String },
    Failed { reason: String },
}

impl PersistenceStatus {
    pub fn is_not_requested(&self) -> bool {
        matches!(self, Self::NotRequested)
    }
}

fn default_persistence_status() -> PersistenceStatus {
    PersistenceStatus::NotRequested
}

/// Overall outcome of a verification execution run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationOutcome {
    /// Every required executable check completed successfully.
    Passed,
    /// At least one check executed and returned a verification failure.
    Failed,
    /// One or more required checks could not be executed conclusively.
    Incomplete,
}

/// Full reproducible record of an executed verification run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationRun {
    /// Unique run identifier.
    pub run_id: String,
    /// The exact plan that was executed.
    pub plan: VerificationPlan,
    /// Top-level verification outcome.
    pub outcome: VerificationOutcome,
    /// Verification assurance level achieved by this execution.
    pub assurance: AssuranceLevel,
    /// Results for every selected check.
    pub checks: Vec<CheckExecutionResult>,
    /// Any execution uncertainties encountered.
    pub uncertainty: Vec<UncertaintyReason>,
    /// Base commit/ref against which verification was planned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Head commit/ref against which verification was planned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// Artifact persistence status.
    #[serde(
        default = "default_persistence_status",
        skip_serializing_if = "PersistenceStatus::is_not_requested"
    )]
    pub persistence_status: PersistenceStatus,
    /// Epoch timestamp when verification run began.
    pub executed_at_ms: u64,
    /// Total wall-clock execution duration in milliseconds.
    pub duration_ms: u64,
}
