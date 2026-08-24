//! Core data structures for Milestone 10: Shadow Calibration.

use crate::intelligence::testplan::model::{VerificationCheckKind, VerificationPlan};
use crate::intelligence::verify::model::CheckExecutionStatus;
use serde::{Deserialize, Serialize};

/// Top-level calibration run status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationStatus {
    /// All reference checks executed conclusively without hitting limits.
    Complete,
    /// Reference checks hit limits (count, duration, timeout) or had non-terminal/cancelled status.
    Incomplete,
    /// Calibration run failed fatally.
    Failed,
}

impl CalibrationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Incomplete => "incomplete",
            Self::Failed => "failed",
        }
    }
}

/// Scope policy for constructing the shadow reference set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceScope {
    /// Include candidate checks plus all checks in packages affected by candidate changes.
    #[default]
    AffectedPackage,
    /// Include candidate checks plus all checks across the entire workspace.
    Workspace,
}

impl ReferenceScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AffectedPackage => "affected",
            Self::Workspace => "workspace",
        }
    }
}

/// Configuration policy bounding shadow calibration execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalibrationPolicy {
    /// Scope of reference check discovery.
    pub scope: ReferenceScope,
    /// Maximum number of checks in the shadow reference set.
    pub max_shadow_checks: usize,
    /// Maximum wall-clock duration in milliseconds for total calibration execution.
    pub max_total_duration_ms: u64,
    /// Per-check execution timeout in milliseconds.
    pub per_check_timeout_ms: u64,
    /// Maximum captured output bytes per shadow check.
    pub max_output_bytes: usize,
}

impl Default for CalibrationPolicy {
    fn default() -> Self {
        Self {
            scope: ReferenceScope::AffectedPackage,
            max_shadow_checks: 50,
            max_total_duration_ms: 60_000,
            per_check_timeout_ms: 10_000,
            max_output_bytes: 16 * 1024 * 1024,
        }
    }
}

/// Classification of a reference check's outcome against the candidate plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalClass {
    /// Selected by candidate plan and produced a real verification failure.
    SelectedSignal,
    /// NOT selected by candidate plan, physically executed, and produced a real verification failure (serious safety signal).
    ObservedShadowMiss,
    /// Selected by candidate plan and executed successfully (passed).
    SelectedPass,
    /// NOT selected by candidate plan and executed successfully (passed). (Descriptive cost observation, NOT a false negative label).
    UnselectedPass,
    /// Execution timed out, failed to spawn, exceeded limits, or was cancelled/skipped.
    Incomplete,
}

impl SignalClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SelectedSignal => "selected_signal",
            Self::ObservedShadowMiss => "observed_shadow_miss",
            Self::SelectedPass => "selected_pass",
            Self::UnselectedPass => "unselected_pass",
            Self::Incomplete => "incomplete",
        }
    }
}

/// Observation for a single check in the shadow reference set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShadowCheckObservation {
    /// Unique check identifier matching PlannedCheck.
    pub check_id: String,
    /// Display name.
    pub display_name: String,
    /// Kind of verification check.
    pub kind: VerificationCheckKind,
    /// Scope (package or workspace).
    pub scope: String,
    /// Whether this check was selected in the evaluated candidate plan.
    pub candidate_selected: bool,
    /// Whether this check was selected in the shadow reference set.
    pub reference_selected: bool,
    /// Final execution status.
    pub execution_status: CheckExecutionStatus,
    /// Whether this check was physically executed via OS process.
    pub has_physical_execution: bool,
    /// Execution duration in milliseconds.
    pub duration_ms: u64,
    /// Signal classification comparing candidate selection vs shadow outcome.
    pub signal_class: SignalClass,
    /// Flag indicating if this was an observed shadow miss (!candidate_selected && failed && physical).
    pub is_observed_shadow_miss: bool,
    /// Optional failure or incomplete reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Record of an individual shadow process execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShadowExecutionObservation {
    pub execution_id: String,
    pub check_id: String,
    pub program: String,
    pub argv_digest: String,
    pub cwd: String,
    pub status: CheckExecutionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_digest: Option<String>,
}

/// Metric eligibility declarations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalibrationEligibility {
    pub eligible_for_miss_rate: bool,
    pub eligible_for_cost_ratio: bool,
    pub eligible_for_runtime_comparison: bool,
}

/// Quantitative and descriptive metrics computed over a shadow calibration run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalibrationMetrics {
    pub candidate_selected_count: usize,
    pub shadow_reference_count: usize,
    pub shadow_executed_count: usize,
    pub selected_failure_count: usize,
    pub unselected_failure_count: usize,
    pub observed_shadow_miss_count: usize,
    pub shadow_incomplete_count: usize,
    pub candidate_execution_duration_ms: u64,
    pub shadow_reference_duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_cost_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal_recall: Option<f64>,
    pub eligibility: CalibrationEligibility,
}

/// Complete reproducible record of a shadow calibration evaluation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalibrationRun {
    pub calibration_id: String,
    pub source_run_id: String,
    pub candidate_plan_digest: String,
    pub policy: CalibrationPolicy,
    pub policy_digest: String,
    pub status: CalibrationStatus,
    pub reference_truncated: bool,
    pub candidate_plan: VerificationPlan,
    pub checks: Vec<ShadowCheckObservation>,
    pub executions: Vec<ShadowExecutionObservation>,
    pub metrics: CalibrationMetrics,
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
    pub duration_ms: u64,
}

/// Summary record of a historical calibration run for listing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalibrationRunSummary {
    pub calibration_id: String,
    pub source_run_id: String,
    pub candidate_plan_digest: String,
    pub policy_digest: String,
    pub status: CalibrationStatus,
    pub reference_scope: String,
    pub candidate_selected_count: usize,
    pub shadow_reference_count: usize,
    pub observed_shadow_miss_count: usize,
    pub signal_recall: Option<f64>,
    pub started_at_ms: u64,
    pub duration_ms: u64,
}

/// Aggregate statistics across completed calibration runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalibrationAggregateStats {
    pub total_calibrations: usize,
    pub complete_calibrations: usize,
    pub incomplete_calibrations: usize,
    pub total_candidate_checks: usize,
    pub total_shadow_checks: usize,
    pub total_observed_misses: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean_selection_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean_runtime_cost_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean_signal_recall: Option<f64>,
}
