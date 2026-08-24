//! Attestation models for Milestone 9: Verification Attestation.
//!
//! Provides in-toto Statement v1 envelope and FlowDeck Verification Predicate v1.

use crate::intelligence::testplan::model::VerificationCheckKind;
use crate::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use crate::protocol::AssuranceLevel;
use serde::{Deserialize, Serialize};

/// Stable in-toto Statement v1 specification type URI.
pub const IN_TOTO_STATEMENT_V1_TYPE: &str = "https://in-toto.io/Statement/v1";

/// Stable FlowDeck Verification Predicate v1 type URI.
pub const FDX_VERIFICATION_PREDICATE_V1_TYPE: &str =
    "https://flowdeck.dev/attestation/vci/verification/v1";

/// Current attestation predicate schema version.
pub const FDX_ATTESTATION_PREDICATE_VERSION: u32 = 1;

/// Generic in-toto Statement v1 envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InTotoStatement<T> {
    #[serde(rename = "_type")]
    pub statement_type: String,
    pub subject: Vec<InTotoSubject>,
    #[serde(rename = "predicateType")]
    pub predicate_type: String,
    pub predicate: T,
}

/// Subject resource bound by the attestation statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InTotoSubject {
    pub name: String,
    pub digest: InTotoDigest,
}

/// Cryptographic digest container for in-toto subjects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InTotoDigest {
    pub sha256: String,
}

/// FlowDeck Verification Predicate v1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationPredicateV1 {
    pub schema_version: u32,
    pub run: AttestedRunIdentity,
    pub plan: AttestedPlan,
    pub result: AttestedVerificationResult,
    pub executions: Vec<AttestedExecution>,
    pub checks: Vec<AttestedCheck>,
    pub uncertainty: Vec<AttestedUncertainty>,
    pub runtime_history: RuntimeHistoryQualification,
    pub source_context: SourceContext,
    pub generator: AttestationGenerator,
}

/// Cryptographically bound identity of the verification run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestedRunIdentity {
    pub run_id: String,
    pub artifact_sha256: String,
    pub plan_sha256: String,
    pub executed_at_ms: u64,
    pub duration_ms: u64,
}

/// Verification plan summary bound in the attestation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestedPlan {
    pub plan_id: String,
    pub plan_sha256: String,
    pub total_obligations: usize,
    pub mandatory_obligations: usize,
    pub advisory_obligations: usize,
}

/// Preserved unresolved obligation with structured scope, reason, and source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestedUnresolvedObligation {
    pub scope: String,
    pub reason: String,
    pub source: String,
}

/// Outcome and assurance achieved by the verification run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestedVerificationResult {
    pub outcome: VerificationOutcome,
    pub assurance: AssuranceLevel,
    pub unresolved_obligation_count: usize,
    pub unresolved_obligations: Vec<AttestedUnresolvedObligation>,
}

/// Qualified physical OS process execution observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestedExecution {
    pub execution_id: String,
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

/// Verified check observation mapped to its execution group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestedCheck {
    pub check_id: String,
    pub kind: VerificationCheckKind,
    pub status: CheckExecutionStatus,
    pub mandatory: bool,
    pub execution_id: String,
    pub has_physical_execution: bool,
    pub reused_execution: bool,
}

/// Structured uncertainty reason preserved without loss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestedUncertainty {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// Historical runtime qualification status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeHistoryQualification {
    pub run_contract_version: i64,
    pub run_qualified: bool,
    pub global_history_complete_at_generation: bool,
}

/// Source workspace context reported at time of verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
    pub changed_files_count: usize,
    pub impacted_targets_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_clean: Option<bool>,
}

/// Metadata identifying the attestation generator tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttestationGenerator {
    pub name: String,
    pub version: String,
}

/// Type alias for the standard verification statement.
pub type VerificationAttestation = InTotoStatement<VerificationPredicateV1>;
