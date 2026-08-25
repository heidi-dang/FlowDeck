//! Centralized bounded insertion helpers and safe bound-state tracking.

use crate::intelligence::build::discover::{
    MAX_DISCOVERED_ARTIFACTS, MAX_DISCOVERED_CONFIGS, MAX_DISCOVERED_EDGES,
    MAX_DISCOVERED_PACKAGES, MAX_DISCOVERED_TARGETS, MAX_WORKSPACE_MEMBERS,
};
use crate::intelligence::build::model::{BuildEdge, BuildTarget, GeneratedArtifact};
use crate::intelligence::build::scope::UncertaintyScope;
use crate::intelligence::build::uncertainty::BuildUncertainty;
use crate::protocol::AssuranceLevel;
use std::collections::HashSet;

pub const MAX_FALLBACK_INVENTORY_ENTRIES: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildLimits {
    pub packages: usize,
    pub configs: usize,
    pub targets: usize,
    pub edges: usize,
    pub artifacts: usize,
    pub workspace_members: usize,
    pub fallback_inventory_entries: usize,
}

impl Default for BuildLimits {
    fn default() -> Self {
        Self {
            packages: MAX_DISCOVERED_PACKAGES,
            configs: MAX_DISCOVERED_CONFIGS,
            targets: MAX_DISCOVERED_TARGETS,
            edges: MAX_DISCOVERED_EDGES,
            artifacts: MAX_DISCOVERED_ARTIFACTS,
            workspace_members: MAX_WORKSPACE_MEMBERS,
            fallback_inventory_entries: MAX_FALLBACK_INVENTORY_ENTRIES,
        }
    }
}

std::thread_local! {
    static TEST_BUILD_LIMITS: std::cell::RefCell<Option<BuildLimits>> = const { std::cell::RefCell::new(None) };
    static TEST_WALKER_ERROR: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

pub fn get_active_build_limits() -> BuildLimits {
    TEST_BUILD_LIMITS.with(|c| c.borrow().unwrap_or_default())
}

pub fn set_test_build_limits(limits: Option<BuildLimits>) {
    TEST_BUILD_LIMITS.with(|c| {
        *c.borrow_mut() = limits;
    });
}

pub fn with_test_build_limits<R>(limits: BuildLimits, f: impl FnOnce() -> R) -> R {
    set_test_build_limits(Some(limits));
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    set_test_build_limits(None);
    match res {
        Ok(val) => val,
        Err(err) => std::panic::resume_unwind(err),
    }
}

pub fn get_test_walker_error() -> Option<String> {
    TEST_WALKER_ERROR.with(|c| c.borrow().clone())
}

pub fn set_test_walker_error(err: Option<String>) {
    TEST_WALKER_ERROR.with(|c| {
        *c.borrow_mut() = err;
    });
}

pub fn with_test_walker_error<R>(err: Option<String>, f: impl FnOnce() -> R) -> R {
    set_test_walker_error(err);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    set_test_walker_error(None);
    match res {
        Ok(val) => val,
        Err(err) => std::panic::resume_unwind(err),
    }
}

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
            if self
                .emitted_categories
                .insert((BuildBoundCategory::Edge, "repository".to_string()))
            {
                uncertainties.push(BuildUncertainty::new(
                    "build_limit_reached",
                    UncertaintyScope::Repository,
                    provider_id,
                    format!("Edge limit {} reached across build topology", limit),
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
            if self.emitted_categories.insert((
                BuildBoundCategory::WorkspaceMember,
                "repository".to_string(),
            )) {
                uncertainties.push(BuildUncertainty::new(
                    "build_limit_reached",
                    UncertaintyScope::Repository,
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
