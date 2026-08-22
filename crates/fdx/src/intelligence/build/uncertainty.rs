//! Scoped uncertainty model and propagation for build/config intelligence.

use crate::intelligence::build::scope::UncertaintyScope;
use crate::protocol::AssuranceLevel;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BuildUncertainty {
    pub code: String,
    pub scope: UncertaintyScope,
    pub provider_id: String,
    pub reason: String,
    pub assurance_ceiling: AssuranceLevel,
    pub should_widen: bool,
}

impl BuildUncertainty {
    pub fn new(
        code: impl Into<String>,
        scope: UncertaintyScope,
        provider_id: impl Into<String>,
        reason: impl Into<String>,
        assurance_ceiling: AssuranceLevel,
        should_widen: bool,
    ) -> Self {
        Self {
            code: code.into(),
            scope,
            provider_id: provider_id.into(),
            reason: reason.into(),
            assurance_ceiling,
            should_widen,
        }
    }
}
