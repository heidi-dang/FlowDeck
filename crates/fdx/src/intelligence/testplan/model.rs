//! Core data structures for Milestone 6: Test Mapping and Verification Planner.

use crate::intelligence::change::explain::EvidencePath;
use crate::intelligence::change::model::SemanticChange;
use crate::intelligence::change::uncertainty::UncertaintyReason;
use crate::protocol::{AssuranceLevel, EvidenceStrength};
use serde::{Deserialize, Serialize};

/// Exhaustive kind of verification check or test target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationCheckKind {
    UnitTest,
    IntegrationTest,
    EndToEndTest,
    Typecheck,
    Lint,
    Build,
    Format,
    Custom,
}

impl VerificationCheckKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::UnitTest => "unit_test",
            Self::IntegrationTest => "integration_test",
            Self::EndToEndTest => "e2e_test",
            Self::Typecheck => "typecheck",
            Self::Lint => "lint",
            Self::Build => "build",
            Self::Format => "format",
            Self::Custom => "custom",
        }
    }
}

/// Why a test or check was selected into the verification plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionReason {
    /// Selected due to direct or transitive evidence path (SCIP / build graph / import).
    Evidence,
    /// Selected due to fail-closed policy widening (stale provider, dynamic config, truncation, root config).
    PolicyWidening,
    /// Selected as a mandatory static package/workspace check (e.g. typecheck/lint on changed package).
    MandatoryCheck,
}

/// A planned verification check or test to be run by execution engines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedCheck {
    /// Stable, unambiguous identifier (e.g. `test:npm:packages/api/tests/user.test.ts`, `check:pkg:npm:packages/api:typecheck`).
    pub check_id: String,
    /// User-friendly display name.
    pub display_name: String,
    /// Kind of check.
    pub kind: VerificationCheckKind,
    /// Owning package or workspace scope (e.g. `pkg:npm:packages/api` or `workspace:root`).
    pub scope: String,
    /// Human-readable explanation of why this check is required.
    pub reason: String,
    /// Selection classification.
    pub selection: SelectionReason,
    /// Strength of the supporting evidence.
    pub strength: EvidenceStrength,
    /// Multi-hop evidence path when selected via graph traversal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_path: Option<EvidencePath>,
    /// Concrete widening trigger code if selected via policy widening.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widening_reason: Option<String>,
    /// Whether this check is mandatory under static verification policy.
    pub mandatory: bool,
}

/// Complete explainable verification plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerificationPlan {
    /// Provable assurance level achieved by the verification set.
    pub assurance: AssuranceLevel,
    /// Classified semantic changes between base and head.
    pub changed: Vec<SemanticChange>,
    /// All impacted targets discovered during graph traversal.
    pub impacted_targets: Vec<crate::intelligence::change::explain::ImpactedTarget>,
    /// Sorted, deduplicated list of checks and tests that must run.
    pub selected_checks: Vec<PlannedCheck>,
    /// Exhaustive list of all uncertainties that triggered widening or degraded assurance.
    pub uncertainty: Vec<UncertaintyReason>,
}

/// Discovered static test file or target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredTest {
    pub stable_id: String,
    pub canonical_path: String,
    pub owning_package_id: Option<String>,
    pub kind: VerificationCheckKind,
}

/// Discovered static package or workspace check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredCheck {
    pub check_id: String,
    pub display_name: String,
    pub owning_scope_id: String,
    pub kind: VerificationCheckKind,
    pub command_or_script: Option<String>,
}

/// Static inventory of tests and checks discovered from repo analysis.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestInventory {
    pub tests: Vec<DiscoveredTest>,
    pub checks: Vec<DiscoveredCheck>,
    pub truncated: bool,
}
