//! Uncertainty reasoning and assurance computation for impact analysis.

use crate::protocol::AssuranceLevel;
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
        }
    }

    pub fn limiting_assurance(&self) -> AssuranceLevel {
        match self {
            Self::DepthLimitReached { .. }
            | Self::NodeLimitReached { .. }
            | Self::EdgeLimitReached { .. }
            | Self::ProviderStale(_)
            | Self::FallbackUsed(_)
            | Self::UnsupportedLanguage(_) => AssuranceLevel::Degraded,

            Self::ProviderMissing(_)
            | Self::ProviderFailed(_)
            | Self::SemanticChangeUnknown(_)
            | Self::AmbiguousSymbol(_) => AssuranceLevel::Conservative,

            Self::MissingBeforeEvidence(_) | Self::MissingAfterEvidence(_) => {
                AssuranceLevel::Unverified
            }
        }
    }
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
