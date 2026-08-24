//! FDX VCI (Verifiable Change Intelligence) Protocol and Semantic Contracts.
//!
//! Provides verifiable evidence provenance, assurance levels, uncertainty triggers
//! with compiler-enforced escalation policies, versioning contracts, and
//! backward-compatible protocol capability negotiation.

use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

// ── Version Constants ──────────────────────────────────────────────────

/// Protocol version over JSON-lines IPC.
pub const FDX_PROTOCOL_VERSION: u32 = 2;

/// Relational SQLite schema version for EvidenceGraph (v3 separates active
/// provider state from attempt diagnostics).
pub const FDX_GRAPH_SCHEMA_VERSION: u32 = 6;

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
            semantic_model_version: 2,
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
    Workspace,
    BuildTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Imports,
    ReExports,
    Calls,
    Defines,
    Exports,
    Extends,
    Implements,
    References,
    Configures,
    Generates,
    Tests,
    OrdersBefore,
    Contains,
    DependsOn,
    BelongsTo,
    Reads,
    Uses,
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
fn parse_path_custom(path_str: &str) -> (Option<&str>, bool, Vec<&str>) {
    let mut s = path_str;
    let mut drive = None;
    if s.len() >= 2 && s.as_bytes()[1] == b':' && (s.as_bytes()[0] as char).is_ascii_alphabetic() {
        drive = Some(&s[..2]);
        s = &s[2..];
    }
    let is_absolute = s.starts_with('/') || s.starts_with('\\');
    let segments: Vec<&str> = s.split(['/', '\\']).filter(|c| !c.is_empty()).collect();
    (drive, is_absolute, segments)
}

fn process_segment<'a>(
    seg: &'a str,
    current_segments: &mut Vec<&'a str>,
    raw_str: &str,
) -> Result<(), PathCanonicalizationError> {
    match seg {
        "." => {}
        ".." => {
            if current_segments.pop().is_none() {
                return Err(PathCanonicalizationError::EscapesRoot(raw_str.to_string()));
            }
        }
        _ => current_segments.push(seg),
    }
    Ok(())
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

    let root_str = root
        .to_str()
        .ok_or(PathCanonicalizationError::InvalidUtf8)?;

    let (path_drive, path_abs, path_segments) = parse_path_custom(raw_str);
    let (root_drive, _root_abs, root_segments) = parse_path_custom(root_str);

    let mut current_segments = Vec::new();

    if path_abs || path_drive.is_some() {
        if let (Some(pd), Some(rd)) = (path_drive, root_drive) {
            if !pd.eq_ignore_ascii_case(rd) {
                return Err(PathCanonicalizationError::EscapesRoot(raw_str.to_string()));
            }
        } else if path_drive.is_some() != root_drive.is_some() {
            return Err(PathCanonicalizationError::EscapesRoot(raw_str.to_string()));
        }

        if path_segments.len() < root_segments.len() {
            return Err(PathCanonicalizationError::EscapesRoot(raw_str.to_string()));
        }
        for (p, r) in path_segments.iter().zip(root_segments.iter()) {
            if p != r {
                return Err(PathCanonicalizationError::EscapesRoot(raw_str.to_string()));
            }
        }

        for &seg in &path_segments[root_segments.len()..] {
            process_segment(seg, &mut current_segments, raw_str)?;
        }
    } else {
        for &seg in &path_segments {
            process_segment(seg, &mut current_segments, raw_str)?;
        }
    }

    Ok(current_segments.join("/"))
}

// ── Protocol Capability Negotiation ───────────────────────────────────

pub const DEFAULT_SERVER_CAPABILITIES: &[&str] = &[
    "read",
    "search",
    "outline",
    "impact-v1",
    "evidence-graph-v1",
    "semantic-status-v1",
    "impact-v2",
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
