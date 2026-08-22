//! Adaptive semantic query-intent routing.
//!
//! Intent classes decide which evidence source is primary and what can be
//! claimed about completeness. Cheap intents stay cheap: LOCALIZE and
//! CONTEXT never consult SCIP; REFERENCE_COMPLETE/RENAME/IMPACT_SEED prefer
//! fresh SCIP and fall back to Tree-sitter structural evidence, then lexical.
//!
//! Queries never execute providers: provider execution belongs to explicit
//! indexing and refresh operations only (fdx semantic refresh).

use crate::intelligence::semantic::health::ProviderFreshness;
use crate::intelligence::semantic::provider::ProviderState;
use crate::intelligence::semantic::LanguageId;
use serde::{Deserialize, Serialize};

/// Query intent classes (Milestone 3 routing primitives).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IntelligenceIntent {
    /// Locate a symbol/entity quickly (cheap source first).
    Localize,
    /// Find references with maximum precision/coverage (fresh SCIP first).
    ReferenceComplete,
    /// References for rename safety (SCIP + lexical safety sweep).
    Rename,
    /// Seed an impact analysis (semantic references first, no transitive).
    ImpactSeed,
    /// Adaptive context: cheapest sufficient source.
    Context,
}

impl IntelligenceIntent {
    pub fn as_str(self) -> &'static str {
        match self {
            IntelligenceIntent::Localize => "localize",
            IntelligenceIntent::ReferenceComplete => "reference_complete",
            IntelligenceIntent::Rename => "rename",
            IntelligenceIntent::ImpactSeed => "impact_seed",
            IntelligenceIntent::Context => "context",
        }
    }
    pub fn parse(s: &str) -> Option<IntelligenceIntent> {
        match s.to_ascii_lowercase().as_str() {
            "localize" => Some(IntelligenceIntent::Localize),
            "reference_complete" | "reference-complete" => {
                Some(IntelligenceIntent::ReferenceComplete)
            }
            "rename" => Some(IntelligenceIntent::Rename),
            "impact_seed" | "impact-seed" => Some(IntelligenceIntent::ImpactSeed),
            "context" => Some(IntelligenceIntent::Context),
            _ => None,
        }
    }
}

/// Evidence source selected by routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSource {
    /// SCIP semantic evidence from a fresh, supported provider.
    Scip,
    /// Tree-sitter structural evidence (degraded but local).
    TreeSitter,
    /// Lexical/index evidence (heuristic).
    Lexical,
}

/// Categorical completeness. No calibrated confidence in Milestone 3: these
/// categories are the only completeness claims allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Completeness {
    /// All references within the provider scope are present (fresh SCIP).
    CompleteWithinProviderScope,
    /// Best-effort lower bound; unknowns possible outside the evidence.
    Conservative,
    /// Provably partial evidence (limits/bounds hit, degraded provider).
    Partial,
    /// No evidence consulted; nothing can be claimed.
    Unknown,
}

/// Policy for provider refresh during queries: never. Refresh is an explicit
/// indexing operation, never a side effect of a read/query path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRefreshPolicy {
    Never,
}

/// Routing decision for one intent + language against current provider states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingPlan {
    pub intent: IntelligenceIntent,
    pub language: LanguageId,
    pub primary: EvidenceSource,
    pub fallbacks: Vec<EvidenceSource>,
    pub completeness_cap: Completeness,
    pub provider_fresh: bool,
    pub refresh_policy: ProviderRefreshPolicy,
}

/// True when any provider state covers lang and is Fresh.
pub fn has_fresh_provider(states: &[ProviderState], lang: LanguageId) -> bool {
    states
        .iter()
        .any(|s| s.freshness == ProviderFreshness::Fresh && s.scope.languages.contains(&lang))
}

/// True when any provider covers lang at all (any health/freshness).
pub fn has_any_provider(states: &[ProviderState], lang: LanguageId) -> bool {
    states.iter().any(|s| s.scope.languages.contains(&lang))
}

/// Compute the routing plan for an intent and language. Pure and cheap:
/// never touches disk, never executes a provider.
pub fn plan_routing(
    intent: IntelligenceIntent,
    language: LanguageId,
    states: &[ProviderState],
) -> RoutingPlan {
    let fresh = has_fresh_provider(states, language);
    let any = has_any_provider(states, language);
    match intent {
        IntelligenceIntent::Localize => RoutingPlan {
            intent,
            language,
            primary: EvidenceSource::Lexical,
            fallbacks: vec![EvidenceSource::TreeSitter],
            completeness_cap: Completeness::Partial,
            provider_fresh: fresh,
            refresh_policy: ProviderRefreshPolicy::Never,
        },
        IntelligenceIntent::ReferenceComplete => RoutingPlan {
            intent,
            language,
            primary: if fresh {
                EvidenceSource::Scip
            } else {
                EvidenceSource::TreeSitter
            },
            fallbacks: if fresh {
                vec![EvidenceSource::TreeSitter, EvidenceSource::Lexical]
            } else {
                vec![EvidenceSource::Lexical]
            },
            completeness_cap: if fresh {
                Completeness::CompleteWithinProviderScope
            } else {
                Completeness::Conservative
            },
            provider_fresh: fresh,
            refresh_policy: ProviderRefreshPolicy::Never,
        },
        IntelligenceIntent::Rename => RoutingPlan {
            intent,
            language,
            primary: if fresh {
                EvidenceSource::Scip
            } else {
                EvidenceSource::TreeSitter
            },
            fallbacks: vec![EvidenceSource::Lexical],
            // Rename safety additionally requires a lexical sweep; a rename
            // is never claimed complete when SCIP is unavailable.
            completeness_cap: Completeness::Conservative,
            provider_fresh: fresh,
            refresh_policy: ProviderRefreshPolicy::Never,
        },
        IntelligenceIntent::ImpactSeed => RoutingPlan {
            intent,
            language,
            primary: if fresh {
                EvidenceSource::Scip
            } else {
                EvidenceSource::TreeSitter
            },
            fallbacks: vec![EvidenceSource::TreeSitter],
            completeness_cap: Completeness::Conservative,
            provider_fresh: fresh,
            refresh_policy: ProviderRefreshPolicy::Never,
        },
        IntelligenceIntent::Context => RoutingPlan {
            intent,
            language,
            primary: EvidenceSource::Lexical,
            fallbacks: vec![EvidenceSource::TreeSitter],
            completeness_cap: Completeness::Unknown,
            provider_fresh: fresh,
            refresh_policy: ProviderRefreshPolicy::Never,
        },
    }
    .with_semantic_fallback_guard(any)
}

impl RoutingPlan {
    /// Semantic fallbacks are only offered when a provider exists for the
    /// language at all; a missing provider means structural/lexical only,
    /// and never a claim of semantic completeness.
    fn with_semantic_fallback_guard(mut self, any_provider: bool) -> Self {
        if !any_provider {
            self.fallbacks.retain(|s| *s != EvidenceSource::Scip);
            if self.primary == EvidenceSource::Scip {
                self.primary = EvidenceSource::TreeSitter;
            }
            if self.completeness_cap == Completeness::CompleteWithinProviderScope {
                self.completeness_cap = Completeness::Conservative;
            }
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intelligence::semantic::health::ProviderHealth;
    use crate::intelligence::semantic::provider::{
        ProviderFingerprint, ProviderIdentity, ProviderScope, ProviderType,
    };

    fn state(id: &str, lang: LanguageId, freshness: ProviderFreshness) -> ProviderState {
        ProviderState {
            identity: ProviderIdentity {
                provider_id: id.to_string(),
                provider_type: ProviderType::Scip,
                provider_version: "1.0".to_string(),
                executable_identity: format!("/bin/{}", id),
                scip_schema_version: "0.1.0".to_string(),
            },
            scope: ProviderScope {
                workspace_root: String::new(),
                package: None,
                languages: vec![lang],
            },
            fingerprint: ProviderFingerprint::compute("1.0", "/bin/x", "0.1.0", None, "cfg"),
            health: ProviderHealth::Available,
            freshness,
            last_successful_run: None,
            output_digest: None,
            failure_reason: None,
            semantic_generation: 0,
        }
    }

    #[test]
    fn reference_complete_prefers_fresh_scip_and_falls_back() {
        let fresh = vec![state(
            "scip-typescript",
            LanguageId::TypeScript,
            ProviderFreshness::Fresh,
        )];
        let plan = plan_routing(
            IntelligenceIntent::ReferenceComplete,
            LanguageId::TypeScript,
            &fresh,
        );
        assert_eq!(plan.primary, EvidenceSource::Scip);
        assert_eq!(
            plan.completeness_cap,
            Completeness::CompleteWithinProviderScope
        );

        let stale = vec![state(
            "scip-typescript",
            LanguageId::TypeScript,
            ProviderFreshness::Stale,
        )];
        let plan2 = plan_routing(
            IntelligenceIntent::ReferenceComplete,
            LanguageId::TypeScript,
            &stale,
        );
        assert_eq!(plan2.primary, EvidenceSource::TreeSitter);
        assert_eq!(plan2.completeness_cap, Completeness::Conservative);

        let absent: Vec<ProviderState> = Vec::new();
        let plan3 = plan_routing(
            IntelligenceIntent::ReferenceComplete,
            LanguageId::Rust,
            &absent,
        );
        assert_eq!(plan3.primary, EvidenceSource::TreeSitter);
        assert_ne!(
            plan3.completeness_cap,
            Completeness::CompleteWithinProviderScope
        );
        assert!(!plan3.fallbacks.contains(&EvidenceSource::Scip));
    }

    #[test]
    fn localize_never_uses_scip() {
        let fresh = vec![state(
            "scip-typescript",
            LanguageId::TypeScript,
            ProviderFreshness::Fresh,
        )];
        let plan = plan_routing(IntelligenceIntent::Localize, LanguageId::TypeScript, &fresh);
        assert_eq!(plan.primary, EvidenceSource::Lexical);
        assert!(!plan.fallbacks.contains(&EvidenceSource::Scip));
        let plan2 = plan_routing(IntelligenceIntent::Context, LanguageId::TypeScript, &fresh);
        assert_eq!(plan2.primary, EvidenceSource::Lexical);
    }

    #[test]
    fn rename_never_claims_complete_without_scip() {
        let stale = vec![state(
            "scip-rust",
            LanguageId::Rust,
            ProviderFreshness::Stale,
        )];
        let plan = plan_routing(IntelligenceIntent::Rename, LanguageId::Rust, &stale);
        assert_eq!(plan.completeness_cap, Completeness::Conservative);
        assert_ne!(
            plan.completeness_cap,
            Completeness::CompleteWithinProviderScope
        );
    }

    #[test]
    fn missing_provider_never_claims_semantic_completeness() {
        // A stale/absent provider must never produce a Complete claim.
        let stale_ts = vec![state(
            "scip-typescript",
            LanguageId::TypeScript,
            ProviderFreshness::Stale,
        )];
        let plan = plan_routing(
            IntelligenceIntent::ReferenceComplete,
            LanguageId::TypeScript,
            &stale_ts,
        );
        assert_ne!(
            plan.completeness_cap,
            Completeness::CompleteWithinProviderScope
        );
    }
}
