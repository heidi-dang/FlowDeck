//! Uncertainty reasoning and assurance computation for impact analysis.

use crate::protocol::{AssuranceLevel, EvidenceRef, EvidenceStrength};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "details", rename_all = "snake_case")]
pub enum UncertaintyReason {
    ProviderMissing(String),
    ProviderStale(String),
    ProviderFailed(String),
    UnsupportedLanguage(String),
    SemanticChangeUnknown(String),
    DepthLimitReached { max_depth: usize },
    NodeLimitReached { max_nodes: usize },
    EdgeLimitReached { max_edges: usize },
    AmbiguousSymbol(String),
    MissingBeforeEvidence(String),
    MissingAfterEvidence(String),
    FallbackUsed(String),
    GraphAbsent(String),
    GraphIncompatible(String),
    GraphCorrupt(String),
    GraphUnavailable(String),
    UnknownGraphRelation(String),
    BuildProviderMissing(String),
    BuildProviderStale(String),
    BuildProviderFailed(String),
    MalformedConfig(String),
    ConfigCycleDetected(String),
    UnknownWorkspaceMembership(String),
    DynamicConfigExpression(String),
    BuildLimitReached(String),
}

impl UncertaintyReason {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ProviderMissing(_) => "provider_missing",
            Self::ProviderStale(_) => "provider_stale",
            Self::ProviderFailed(_) => "provider_failed",
            Self::UnsupportedLanguage(_) => "unsupported_language",
            Self::SemanticChangeUnknown(_) => "semantic_change_unknown",
            Self::DepthLimitReached { .. } => "depth_limit_reached",
            Self::NodeLimitReached { .. } => "node_limit_reached",
            Self::EdgeLimitReached { .. } => "edge_limit_reached",
            Self::AmbiguousSymbol(_) => "ambiguous_symbol",
            Self::MissingBeforeEvidence(_) => "missing_before_evidence",
            Self::MissingAfterEvidence(_) => "missing_after_evidence",
            Self::FallbackUsed(_) => "fallback_used",
            Self::GraphAbsent(_) => "graph_absent",
            Self::GraphIncompatible(_) => "graph_incompatible",
            Self::GraphCorrupt(_) => "graph_corrupt",
            Self::GraphUnavailable(_) => "graph_unavailable",
            Self::UnknownGraphRelation(_) => "unknown_graph_relation",
            Self::BuildProviderMissing(_) => "build_provider_missing",
            Self::BuildProviderStale(_) => "build_provider_stale",
            Self::BuildProviderFailed(_) => "build_provider_failed",
            Self::MalformedConfig(_) => "malformed_config",
            Self::ConfigCycleDetected(_) => "config_cycle_detected",
            Self::UnknownWorkspaceMembership(_) => "unknown_workspace_membership",
            Self::DynamicConfigExpression(_) => "dynamic_config_expression",
            Self::BuildLimitReached(_) => "build_limit_reached",
        }
    }

    pub fn limiting_assurance(&self) -> AssuranceLevel {
        match self {
            Self::DepthLimitReached { .. }
            | Self::NodeLimitReached { .. }
            | Self::EdgeLimitReached { .. }
            | Self::ProviderStale(_)
            | Self::BuildProviderStale(_)
            | Self::FallbackUsed(_)
            | Self::UnsupportedLanguage(_)
            | Self::GraphAbsent(_)
            | Self::UnknownGraphRelation(_)
            | Self::MalformedConfig(_)
            | Self::ConfigCycleDetected(_)
            | Self::UnknownWorkspaceMembership(_)
            | Self::DynamicConfigExpression(_)
            | Self::BuildLimitReached(_) => AssuranceLevel::Degraded,

            Self::BuildProviderMissing(_) | Self::BuildProviderFailed(_) => {
                AssuranceLevel::Conservative
            }

            Self::ProviderMissing(_)
            | Self::ProviderFailed(_)
            | Self::SemanticChangeUnknown(_)
            | Self::AmbiguousSymbol(_) => AssuranceLevel::Conservative,

            Self::MissingBeforeEvidence(_)
            | Self::MissingAfterEvidence(_)
            | Self::GraphIncompatible(_)
            | Self::GraphCorrupt(_)
            | Self::GraphUnavailable(_) => AssuranceLevel::Unverified,
        }
    }
}

/// Compute minimum evidence strength across a set of evidence references.
pub fn minimum_evidence_strength(evidence: &[EvidenceRef]) -> EvidenceStrength {
    if evidence.is_empty() {
        return EvidenceStrength::Unknown;
    }
    let mut min_str = EvidenceStrength::Precise;
    for ev in evidence {
        if ev.strength < min_str {
            min_str = ev.strength;
        }
    }
    min_str
}

/// Map an evidence strength to its maximum achievable assurance level.
pub fn assurance_ceiling_for_strength(strength: EvidenceStrength) -> AssuranceLevel {
    match strength {
        EvidenceStrength::Precise => AssuranceLevel::Exact,
        EvidenceStrength::Observed => AssuranceLevel::Conservative,
        EvidenceStrength::Structural => AssuranceLevel::Degraded,
        EvidenceStrength::Heuristic => AssuranceLevel::Degraded,
        EvidenceStrength::Unknown => AssuranceLevel::Unverified,
    }
}

/// Compute assurance ceiling directly from a list of evidence references.
pub fn assurance_ceiling_for_evidence(evidence: &[EvidenceRef]) -> AssuranceLevel {
    let min_str = minimum_evidence_strength(evidence);
    assurance_ceiling_for_strength(min_str)
}

/// Combine two assurance levels into the conservative minimum.
pub fn combine_assurance(a: AssuranceLevel, b: AssuranceLevel) -> AssuranceLevel {
    std::cmp::min(a, b)
}

/// Compute aggregate assurance level from base change assurance, traversal findings, and uncertainty reasons.
pub fn compute_result_assurance(
    change_assurance: AssuranceLevel,
    uncertainties: &[UncertaintyReason],
    has_fallback_path: bool,
) -> AssuranceLevel {
    let mut level = change_assurance;

    if has_fallback_path && level > AssuranceLevel::Degraded {
        level = AssuranceLevel::Degraded;
    }

    for u in uncertainties {
        let limit = u.limiting_assurance();
        if limit < level {
            level = limit;
        }
    }

    level
}
