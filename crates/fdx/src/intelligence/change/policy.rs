//! Typed graph edge propagation policy.

use crate::protocol::EdgeKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraversalDirection {
    Forward,
    Reverse,
    Both,
}

#[derive(Debug, Clone)]
pub struct ImpactPolicy {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_edges: usize,
    pub max_paths_per_target: usize,
}

impl Default for ImpactPolicy {
    fn default() -> Self {
        Self {
            max_depth: 3,
            max_nodes: 10_000,
            max_edges: 50_000,
            max_paths_per_target: 3,
        }
    }
}

/// Determine how impact propagates along a typed edge kind.
pub fn edge_impact_direction(kind: EdgeKind) -> TraversalDirection {
    match kind {
        // Target change propagates to source (e.g. caller <- callee, importer <- imported, impl <- iface)
        EdgeKind::Defines => TraversalDirection::Reverse,
        EdgeKind::References => TraversalDirection::Reverse,
        EdgeKind::Calls => TraversalDirection::Reverse,
        EdgeKind::Imports => TraversalDirection::Reverse,
        EdgeKind::Exports => TraversalDirection::Reverse,
        EdgeKind::ReExports => TraversalDirection::Reverse,
        EdgeKind::Implements => TraversalDirection::Reverse,
        EdgeKind::Extends => TraversalDirection::Reverse,
        EdgeKind::Tests => TraversalDirection::Reverse,
        EdgeKind::OrdersBefore => TraversalDirection::Reverse,

        EdgeKind::DependsOn => TraversalDirection::Reverse,
        EdgeKind::BelongsTo => TraversalDirection::Reverse,
        EdgeKind::Reads => TraversalDirection::Reverse,
        EdgeKind::Uses => TraversalDirection::Reverse,

        // Source change propagates to target (e.g. config file changed -> target impacted)
        EdgeKind::Configures => TraversalDirection::Forward,
        EdgeKind::Generates => TraversalDirection::Forward,

        // Bidirectional: package contains file (file changes -> package impacted; package changes -> file impacted)
        // and workspace contains package (package changes -> workspace impacted; workspace changes -> package impacted)
        EdgeKind::Contains => TraversalDirection::Both,
    }
}
