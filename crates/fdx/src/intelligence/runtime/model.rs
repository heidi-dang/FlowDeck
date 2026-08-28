//! Core data structures for Milestone 8: Runtime Evidence & Historical Verification Intelligence.
//!
//! Represents durable runtime observations without promoting them to semantic assertions.

use crate::intelligence::testplan::model::VerificationCheckKind;
use crate::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use crate::protocol::AssuranceLevel;
use serde::{Deserialize, Serialize};

/// Ingestion contract version for runtime runs.
/// 1 = legacy/unqualified v6 ingestion
/// 2 = exact-byte v7 ingestion
pub const INGESTION_CONTRACT_VERSION_V2: i64 = 2;

/// Observation record of an entire completed verification run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeRunObservation {
    pub run_id: String,
    pub artifact_digest: String,
    pub plan_digest: String,
    pub outcome: VerificationOutcome,
    pub assurance: AssuranceLevel,
    pub executed_at_ms: u64,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub imported_at_ms: u64,
    #[serde(default = "default_contract_version")]
    pub ingestion_contract_version: i64,
}

fn default_contract_version() -> i64 {
    INGESTION_CONTRACT_VERSION_V2
}

/// Observation record of an actual OS process execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeExecutionObservation {
    pub execution_id: String,
    pub run_id: String,
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
    pub stdout_captured_bytes: u64,
    pub stderr_captured_bytes: u64,
    pub output_truncated: bool,
}

/// Observation record of a verification check obligation mapped to its execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeCheckObservation {
    pub run_id: String,
    pub check_id: String,
    pub execution_id: String,
    pub kind: VerificationCheckKind,
    pub status: CheckExecutionStatus,
    pub reused_execution: bool,
    pub mandatory: bool,
    #[serde(default)]
    pub has_physical_execution: bool,
}

/// Observation record of changed entities that co-occurred during a verification run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeChangeObservation {
    pub run_id: String,
    pub entity_id: String,
    pub entity_kind: String,
}

/// Result of ingesting a single verification run artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum RuntimeIngestResult {
    Imported {
        run_id: String,
        artifact_digest: String,
    },
    AlreadyImported {
        run_id: String,
        artifact_digest: String,
    },
    Conflict {
        run_id: String,
        existing_digest: String,
        incoming_digest: String,
    },
    Failed {
        run_id: Option<String>,
        reason: String,
    },
}

/// Historical statistics and descriptive metrics for a specific check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckHistoryStats {
    pub check_id: String,
    pub total_observations: u64,
    pub unique_executions: u64,
    pub pass_count: u64,
    pub real_failure_count: u64,
    pub incomplete_count: u64,
    pub last_observed_at_ms: Option<u64>,
    pub last_passed_at_ms: Option<u64>,
    pub min_duration_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
    pub median_duration_ms: Option<f64>,
    pub p95_duration_ms: Option<f64>,
    pub flake_signal: HistoricalFlakeSignal,
}

/// Descriptive flake observations (passes alongside real failures).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoricalFlakeSignal {
    pub observed_passes: u64,
    pub observed_failures: u64,
    pub incomplete_observations: u64,
    pub transition_count: u64,
    pub is_flake_signal_present: bool,
}

/// Overall summary of historical verification database reconciliation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryReconciliationReport {
    pub reconciled_at_ms: u64,
    pub artifacts_discovered: u64,
    pub artifacts_imported: u64,
    pub artifacts_already_present: u64,
    pub artifacts_conflicted: u64,
    pub artifacts_failed: u64,
    pub is_complete: bool,
    pub errors: Vec<String>,
}
