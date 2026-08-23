//! Ephemeral, read-only current build and config topology snapshot.
//!
//! Reuses static build providers to parse the current working tree on-the-fly
//! without performing database writes, executing compiler/package managers, or modifying disk.

use crate::intelligence::build::freshness::get_build_providers;
use crate::intelligence::build::model::*;
use crate::intelligence::build::uncertainty::BuildUncertainty;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct CurrentBuildSnapshot {
    pub nodes: HashMap<String, BuildNode>,
    pub edges: Vec<BuildEdge>,
    pub uncertainties: Vec<BuildUncertainty>,
    pub contains_file_to_packages: HashMap<String, Vec<String>>,
    pub contains_package_to_files: HashMap<String, Vec<String>>,
    pub depends_on_reverse: HashMap<String, Vec<String>>,
    pub extends_reverse: HashMap<String, Vec<String>>,
    pub references_reverse: HashMap<String, Vec<String>>,
    pub configures_reverse: HashMap<String, Vec<String>>,
    pub belongs_to_reverse: HashMap<String, Vec<String>>,
    pub defines_reverse: HashMap<String, Vec<String>>,
    pub package_to_owning_workspace: HashMap<String, String>,
}

impl CurrentBuildSnapshot {
    /// Build an ephemeral snapshot by executing passive ingest across detected providers.
    pub fn build(repo_root: &Path) -> Self {
        let mut snapshot = Self::default();
        let providers = get_build_providers();

        for prov in providers {
            if !prov.detect(repo_root) {
                continue;
            }
            if let Ok(ingest_res) = prov.ingest(repo_root) {
                snapshot.uncertainties.extend(ingest_res.uncertainties);

                for node in ingest_res.nodes {
                    snapshot.nodes.insert(node.stable_id.clone(), node);
                }

                for ws in ingest_res.workspaces {
                    for member in ws.members {
                        snapshot
                            .package_to_owning_workspace
                            .insert(member, ws.stable_id.clone());
                    }
                }

                for edge in ingest_res.edges {
                    match edge.kind {
                        crate::protocol::EdgeKind::Contains => {
                            if edge.to_node.starts_with("file:") {
                                // Package CONTAINS file
                                let file_path =
                                    edge.to_node.strip_prefix("file:").unwrap_or(&edge.to_node);
                                snapshot
                                    .contains_file_to_packages
                                    .entry(file_path.to_string())
                                    .or_default()
                                    .push(edge.from_node.clone());
                                snapshot
                                    .contains_package_to_files
                                    .entry(edge.from_node.clone())
                                    .or_default()
                                    .push(file_path.to_string());
                            }
                        }
                        crate::protocol::EdgeKind::DependsOn => {
                            // A DEPENDS_ON B -> changing B impacts A (reverse)
                            snapshot
                                .depends_on_reverse
                                .entry(edge.to_node.clone())
                                .or_default()
                                .push(edge.from_node.clone());
                        }
                        crate::protocol::EdgeKind::Extends => {
                            snapshot
                                .extends_reverse
                                .entry(edge.to_node.clone())
                                .or_default()
                                .push(edge.from_node.clone());
                        }
                        crate::protocol::EdgeKind::References => {
                            snapshot
                                .references_reverse
                                .entry(edge.to_node.clone())
                                .or_default()
                                .push(edge.from_node.clone());
                        }
                        crate::protocol::EdgeKind::Configures => {
                            // Config CONFIGURES Package -> changing Config impacts Package (forward)
                            snapshot
                                .configures_reverse
                                .entry(edge.from_node.clone())
                                .or_default()
                                .push(edge.to_node.clone());
                        }
                        crate::protocol::EdgeKind::BelongsTo => {
                            // Target BELONGS_TO Package
                            snapshot
                                .belongs_to_reverse
                                .entry(edge.to_node.clone())
                                .or_default()
                                .push(edge.from_node.clone());
                        }
                        crate::protocol::EdgeKind::Defines => {
                            // File DEFINES Package/Config/Workspace
                            snapshot
                                .defines_reverse
                                .entry(edge.from_node.clone())
                                .or_default()
                                .push(edge.to_node.clone());
                        }
                        _ => {}
                    }
                    snapshot.edges.push(edge);
                }
            }
        }

        snapshot
    }

    /// Query current snapshot for incoming edges to target_node
    pub fn find_incoming_edges(&self, target_node: &str) -> Vec<BuildEdge> {
        let mut edges = Vec::new();
        let mut seen = HashSet::new();

        // 1. Reverse edges: to_node == target_node (e.g. A depends_on target, target contains file)
        for edge in &self.edges {
            let is_match = match edge.kind {
                crate::protocol::EdgeKind::Contains => {
                    // When target_node is file:X, edge pkg CONTAINS file:X applies
                    edge.to_node == target_node && target_node.starts_with("file:")
                }
                crate::protocol::EdgeKind::DependsOn
                | crate::protocol::EdgeKind::Extends
                | crate::protocol::EdgeKind::References
                | crate::protocol::EdgeKind::BelongsTo
                | crate::protocol::EdgeKind::Reads
                | crate::protocol::EdgeKind::Uses => edge.to_node == target_node,
                crate::protocol::EdgeKind::Configures | crate::protocol::EdgeKind::Generates => {
                    edge.from_node == target_node
                }
                crate::protocol::EdgeKind::Defines => edge.from_node == target_node,
                _ => false,
            };

            if is_match && seen.insert(edge.stable_id.clone()) {
                edges.push(edge.clone());
            }
        }

        edges
    }
}
