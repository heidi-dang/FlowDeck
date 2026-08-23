//! Centralized bounded insertion helpers and safe bound-state tracking.

use crate::intelligence::build::model::{BuildEdge, BuildTarget, GeneratedArtifact};
use crate::intelligence::build::scope::UncertaintyScope;
use crate::intelligence::build::uncertainty::BuildUncertainty;
use crate::protocol::AssuranceLevel;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BuildBoundCategory {
    Package,
    WorkspaceMember,
    Config,
    Target,
    Edge,
    Artifact,
}

impl BuildBoundCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Package => "package",
            Self::WorkspaceMember => "workspace_member",
            Self::Config => "config",
            Self::Target => "target",
            Self::Edge => "edge",
            Self::Artifact => "artifact",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct BuildBoundsCollector {
    pub emitted_categories: HashSet<(BuildBoundCategory, String)>,
}

impl BuildBoundsCollector {
    pub fn push_bounded_edge(
        &mut self,
        edges: &mut Vec<BuildEdge>,
        uncertainties: &mut Vec<BuildUncertainty>,
        edge: BuildEdge,
        limit: usize,
        provider_id: &'static str,
        scope: UncertaintyScope,
    ) -> bool {
        if edges.len() < limit {
            edges.push(edge);
            true
        } else {
            let scope_key = scope.as_str().to_string();
            if self
                .emitted_categories
                .insert((BuildBoundCategory::Edge, scope_key))
            {
                uncertainties.push(BuildUncertainty::new(
                    "build_limit_reached",
                    scope,
                    provider_id,
                    format!("Edge limit {} reached in category 'edge'", limit),
                    AssuranceLevel::Degraded,
                    true,
                ));
            }
            false
        }
    }

    pub fn push_bounded_target(
        &mut self,
        targets: &mut Vec<BuildTarget>,
        uncertainties: &mut Vec<BuildUncertainty>,
        target: BuildTarget,
        limit: usize,
        provider_id: &'static str,
        scope: UncertaintyScope,
    ) -> bool {
        if targets.len() < limit {
            targets.push(target);
            true
        } else {
            let scope_key = scope.as_str().to_string();
            if self
                .emitted_categories
                .insert((BuildBoundCategory::Target, scope_key))
            {
                uncertainties.push(BuildUncertainty::new(
                    "build_limit_reached",
                    scope,
                    provider_id,
                    format!("Target limit {} reached in category 'target'", limit),
                    AssuranceLevel::Degraded,
                    true,
                ));
            }
            false
        }
    }

    pub fn push_bounded_artifact(
        &mut self,
        artifacts: &mut Vec<GeneratedArtifact>,
        uncertainties: &mut Vec<BuildUncertainty>,
        artifact: GeneratedArtifact,
        limit: usize,
        provider_id: &'static str,
        scope: UncertaintyScope,
    ) -> bool {
        if artifacts.len() < limit {
            artifacts.push(artifact);
            true
        } else {
            let scope_key = scope.as_str().to_string();
            if self
                .emitted_categories
                .insert((BuildBoundCategory::Artifact, scope_key))
            {
                uncertainties.push(BuildUncertainty::new(
                    "build_limit_reached",
                    scope,
                    provider_id,
                    format!("Artifact limit {} reached in category 'artifact'", limit),
                    AssuranceLevel::Degraded,
                    true,
                ));
            }
            false
        }
    }

    pub fn push_bounded_workspace_member(
        &mut self,
        members: &mut Vec<String>,
        uncertainties: &mut Vec<BuildUncertainty>,
        member_id: String,
        limit: usize,
        provider_id: &'static str,
        scope: UncertaintyScope,
    ) -> bool {
        if members.len() < limit {
            members.push(member_id);
            true
        } else {
            let scope_key = scope.as_str().to_string();
            if self
                .emitted_categories
                .insert((BuildBoundCategory::WorkspaceMember, scope_key))
            {
                uncertainties.push(BuildUncertainty::new(
                    "build_limit_reached",
                    scope,
                    provider_id,
                    format!(
                        "Workspace member limit {} reached in category 'workspace_member'",
                        limit
                    ),
                    AssuranceLevel::Degraded,
                    true,
                ));
            }
            false
        }
    }
}
