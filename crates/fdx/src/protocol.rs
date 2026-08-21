//! FDX VCI (Verifiable Change Intelligence) Protocol and Semantic Contracts.
//!
//! Provides verifiable evidence provenance, assurance levels, uncertainty triggers
//! with compiler-enforced escalation policies, versioning contracts, and
//! backward-compatible protocol capability negotiation.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path};
use thiserror::Error;

// ── Version Constants ──────────────────────────────────────────────────

/// Protocol version over JSON-lines IPC.
pub const FDX_PROTOCOL_VERSION: u32 = 2;

/// Relational SQLite schema version for EvidenceGraph.
pub const FDX_GRAPH_SCHEMA_VERSION: u32 = 1;

/// Selection and escalation algorithm policy version.
pub const FDX_SELECTION_POLICY_VERSION: u32 = 1;

/// in-toto-compatible attestation statement predicate version.
pub const FDX_ATTESTATION_PREDICATE_VERSION: u32 = 1;

// ── Evidence Strength & Providers ─────────────────────────────────────

/// Degree of semantic verification backing an edge or claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStrength {
    /// Explicitly unknown or unresolved relationship.
    Unknown = 0,
    /// Name-based, path-based, or heuristic association.
    Heuristic = 1,
    /// Tree-sitter AST structural dependency (import, class hierarchy, etc.).
    Structural = 2,
    /// Build/execution observation, trace, or test run.
    Observed = 3,
    /// Compiler-verified or SCIP symbol-precise reference.
    Precise = 4,
}

/// The origin provider that produced the evidence.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceProviderKind {
    Scip,
    CompilerNative,
    TreeSitter,
    BuildNative,
    RunnerNative,
    RuntimeObserved,
    Historical,
    ManualRule,
}

/// Metadata indicating the freshness of an evidence reference.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct FreshnessMetadata {
    pub recorded_at: u64,
    pub source_mtime_ms: Option<u64>,
    pub source_content_hash: Option<String>,
    pub is_stale: bool,
}

/// Verifiable evidence reference backing a graph entity or relation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub provider: EvidenceProviderKind,
    pub provider_fingerprint: String,
    pub strength: EvidenceStrength,
    pub source_identity: String,
    pub source_hash: Option<String>,
    #[serde(default)]
    pub freshness: FreshnessMetadata,
}

// ── Assurance Model ───────────────────────────────────────────────────

/// Provable assurance level achieved by a verification set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum AssuranceLevel {
    /// Insufficient evidence to construct a verifiable safety boundary.
    Unverified = 0,
    /// Fallback or degraded evidence provider; verification boundary expanded.
    Degraded = 1,
    /// Safely escalated containment boundary covering all uncertainties.
    Conservative = 2,
    /// 100% precise symbol-level evidence covering all changes.
    Exact = 3,
}

/// Maximum achievable assurance level for the current repository and environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssuranceCeiling {
    pub max_level: AssuranceLevel,
    pub limiting_reasons: Vec<String>,
}

impl Default for AssuranceCeiling {
    fn default() -> Self {
        Self {
            max_level: AssuranceLevel::Exact,
            limiting_reasons: Vec::new(),
        }
    }
}

// ── Unknown Triggers & Containment Scopes ──────────────────────────────

/// Granularity of impact containment boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImpactScope {
    /// Affected file or symbol target only.
    Target = 1,
    /// Enclosing package boundary.
    Package = 2,
    /// Immediate direct downstream dependent packages.
    DependentPackages = 3,
    /// Entire repository workspace.
    Workspace = 4,
    /// Full test suite across all packages.
    FullTestSuite = 5,
    /// Full verification pipeline (typecheck, lint, build, test, docs).
    FullVerification = 6,
}

/// Risk severity of an unresolved unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskSeverity {
    Low = 1,
    Medium = 2,
    High = 3,
    Critical = 4,
}

/// Exhaustive enumeration of semantic uncertainty triggers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownTrigger {
    DynamicImport,
    Reflection,
    Eval,
    RuntimePluginLoading,
    DependencyInjection,
    LockfileChange,
    BuildConfigChange,
    CompilerConfigChange,
    SchemaChange,
    GeneratedArtifactChange,
    UnsupportedLanguage,
    StaleSemanticProvider,
    ProviderMismatch,
    ExternalContractChange,
    TestOrderDependency,
}

impl UnknownTrigger {
    /// Returns the default escalation policy (containment scope and risk severity).
    /// Enforced exhaustively by the compiler.
    pub fn escalation_policy(&self) -> (ImpactScope, RiskSeverity) {
        match self {
            Self::DynamicImport => (ImpactScope::Package, RiskSeverity::Medium),
            Self::Reflection => (ImpactScope::Package, RiskSeverity::High),
            Self::Eval => (ImpactScope::Package, RiskSeverity::Critical),
            Self::RuntimePluginLoading => (ImpactScope::Workspace, RiskSeverity::High),
            Self::DependencyInjection => (ImpactScope::DependentPackages, RiskSeverity::Medium),
            Self::LockfileChange => (ImpactScope::FullTestSuite, RiskSeverity::High),
            Self::BuildConfigChange => (ImpactScope::Workspace, RiskSeverity::High),
            Self::CompilerConfigChange => (ImpactScope::FullVerification, RiskSeverity::Critical),
            Self::SchemaChange => (ImpactScope::DependentPackages, RiskSeverity::High),
            Self::GeneratedArtifactChange => (ImpactScope::DependentPackages, RiskSeverity::Medium),
            Self::UnsupportedLanguage => (ImpactScope::Package, RiskSeverity::Medium),
            Self::StaleSemanticProvider => (ImpactScope::DependentPackages, RiskSeverity::Medium),
            Self::ProviderMismatch => (ImpactScope::DependentPackages, RiskSeverity::Low),
            Self::ExternalContractChange => (ImpactScope::Workspace, RiskSeverity::High),
            Self::TestOrderDependency => (ImpactScope::FullTestSuite, RiskSeverity::High),
        }
    }
}

/// Structured uncertainty instance with concrete evidence and scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Uncertainty {
    pub trigger: UnknownTrigger,
    pub scope: ImpactScope,
    pub severity: RiskSeverity,
    #[serde(default)]
    pub evidence: Vec<EvidenceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl Uncertainty {
    pub fn from_trigger(trigger: UnknownTrigger, details: Option<String>) -> Self {
        let (scope, severity) = trigger.escalation_policy();
        Self {
            trigger,
            scope,
            severity,
            evidence: Vec::new(),
            details,
        }
    }
}

// ── Test Mapping Granularity ──────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestMappingGranularity {
    Workspace,
    Package,
    File,
    Symbol,
    Branch,
}

// ── Graph Compatibility ───────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphCompatibility {
    pub graph_schema_version: u32,
    pub semantic_model_version: u32,
    pub selection_policy_version: u32,
    pub provider_fingerprint: String,
    pub build_adapter_fingerprint: String,
}

impl Default for GraphCompatibility {
    fn default() -> Self {
        Self {
            graph_schema_version: FDX_GRAPH_SCHEMA_VERSION,
            semantic_model_version: 1,
            selection_policy_version: FDX_SELECTION_POLICY_VERSION,
            provider_fingerprint: format!("fdx-native-{}", env!("CARGO_PKG_VERSION")),
            build_adapter_fingerprint: "native-v1".to_string(),
        }
    }
}

// ── Node & Edge Kinds ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    File,
    Module,
    Package,
    Symbol,
    Test,
    Config,
    GeneratedArtifact,
    ExternalDependency,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Imports,
    ReExports,
    Calls,
    Defines,
    Extends,
    Implements,
    References,
    Configures,
    Generates,
    Tests,
    OrdersBefore,
}

// ── Query Routing Intents ─────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum QueryIntent {
    Localize,
    ReferenceComplete,
    Impact,
    Rename,
    Context,
}

// ── Path Canonicalization ─────────────────────────────────────────────

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PathCanonicalizationError {
    #[error("Path escapes repository root jail: {0}")]
    EscapesRoot(String),
    #[error("Path contains invalid UTF-8 bytes")]
    InvalidUtf8,
    #[error("Path is empty")]
    EmptyPath,
}

/// Canonicalizes a path relative to the repository root.
/// Invariants:
/// - Repository-relative
/// - UTF-8 encoded
/// - Normal forward slashes ('/')
/// - No '.' or '..' components
/// - Stripped drive letters
/// - Jailed inside root
pub fn canonicalize_repo_path(
    path: &Path,
    root: &Path,
) -> Result<String, PathCanonicalizationError> {
    let raw_str = path
        .to_str()
        .ok_or(PathCanonicalizationError::InvalidUtf8)?;
    if raw_str.trim().is_empty() {
        return Err(PathCanonicalizationError::EmptyPath);
    }

    // Strip Windows drive letters if present (e.g., C:/foo -> /foo or foo)
    let cleaned_path = if raw_str.len() >= 2
        && raw_str.as_bytes()[1] == b':'
        && (raw_str.as_bytes()[0] as char).is_ascii_alphabetic()
    {
        Path::new(&raw_str[2..])
    } else {
        path
    };

    let target = if cleaned_path.is_absolute() {
        if let Ok(rel) = cleaned_path.strip_prefix(root) {
            rel.to_path_buf()
        } else {
            cleaned_path.to_path_buf()
        }
    } else {
        cleaned_path.to_path_buf()
    };

    let mut segments = Vec::new();
    for comp in target.components() {
        match comp {
            Component::Normal(s) => {
                let s_str = s.to_str().ok_or(PathCanonicalizationError::InvalidUtf8)?;
                segments.push(s_str);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if segments.pop().is_none() {
                    return Err(PathCanonicalizationError::EscapesRoot(raw_str.to_string()));
                }
            }
            Component::RootDir | Component::Prefix(_) => {}
        }
    }

    Ok(segments.join("/"))
}

// ── Protocol Capability Negotiation ───────────────────────────────────

pub const DEFAULT_SERVER_CAPABILITIES: &[&str] = &[
    "read",
    "search",
    "outline",
    "impact-v1",
    "impact-v2",
    "evidence-graph-v1",
    "vci-v1",
    "why-v1",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NegotiateRequest {
    #[serde(default = "default_protocol_version")]
    pub protocol: u32,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

fn default_protocol_version() -> u32 {
    FDX_PROTOCOL_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NegotiateResponse {
    pub protocol: u32,
    pub selected_capabilities: Vec<String>,
    pub server_capabilities: Vec<String>,
    pub graph_schema_version: u32,
    pub selection_policy_version: u32,
    pub attestation_predicate_version: u32,
}

impl NegotiateResponse {
    pub fn negotiate(req: &NegotiateRequest) -> Self {
        let protocol = std::cmp::min(req.protocol, FDX_PROTOCOL_VERSION);
        let server_caps: Vec<String> = DEFAULT_SERVER_CAPABILITIES
            .iter()
            .map(|s| s.to_string())
            .collect();
        let selected_capabilities = if req.capabilities.is_empty() {
            server_caps.clone()
        } else {
            req.capabilities
                .iter()
                .filter(|c| server_caps.contains(c))
                .cloned()
                .collect()
        };

        Self {
            protocol,
            selected_capabilities,
            server_capabilities: server_caps,
            graph_schema_version: FDX_GRAPH_SCHEMA_VERSION,
            selection_policy_version: FDX_SELECTION_POLICY_VERSION,
            attestation_predicate_version: FDX_ATTESTATION_PREDICATE_VERSION,
        }
    }
}
