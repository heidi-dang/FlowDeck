//! Milestone 4: Verifiable Change Intelligence (Change classification, transitive impact, explanations, uncertainty propagation).

pub mod classify;
pub mod explain;
pub mod model;
pub mod policy;
pub mod seed;
pub mod traverse;
pub mod uncertainty;

pub use classify::classify_changes;
pub use explain::{EvidencePath, EvidenceStep, ImpactedTarget};
pub use model::{ChangeKind, ChangeSet, ChangeSubject, SemanticChange, SemanticChangeKind};
pub use policy::ImpactPolicy;
pub use seed::{generate_impact_seeds, ImpactSeed};
pub use traverse::{analyze_impact_v2, explain_why_target, ImpactV2Result, TraverseError};
pub use uncertainty::UncertaintyReason;
