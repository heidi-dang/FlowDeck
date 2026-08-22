//! Evidence-path reconstruction and human-readable explanation rendering.

use crate::protocol::{EdgeKind, EvidenceStrength, NodeKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceStep {
    pub from_node: String,
    pub edge_kind: EdgeKind,
    pub to_node: String,
    pub provider: String,
    pub strength: EvidenceStrength,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidencePath {
    pub change_id: String,
    pub seed_node: String,
    pub target_node: String,
    pub steps: Vec<EvidenceStep>,
    pub path_strength: EvidenceStrength,
    pub explanation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImpactedTarget {
    pub target: String,
    pub target_kind: NodeKind,
    pub depth: usize,
    pub strength: EvidenceStrength,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_path: Option<EvidencePath>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub alternate_paths: Vec<EvidencePath>,
    #[serde(default)]
    pub alternate_path_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widening_reason: Option<String>,
}

fn format_node_label(node_id: &str) -> &str {
    if let Some(stripped) = node_id.strip_prefix("file:") {
        stripped
    } else if let Some(stripped) = node_id.strip_prefix("sym:") {
        stripped
    } else {
        node_id
    }
}

fn format_edge_verb(kind: EdgeKind) -> &'static str {
    match kind {
        EdgeKind::Imports => "imports",
        EdgeKind::ReExports => "re-exports",
        EdgeKind::Calls => "calls",
        EdgeKind::Defines => "defines",
        EdgeKind::Exports => "exports",
        EdgeKind::Extends => "extends",
        EdgeKind::Implements => "implements",
        EdgeKind::References => "references",
        EdgeKind::Configures => "configures",
        EdgeKind::Generates => "generates",
        EdgeKind::Tests => "tests",
        EdgeKind::OrdersBefore => "is ordered before",
    }
}

/// Render a human-readable multi-hop evidence explanation from a sequence of steps.
pub fn render_path_explanation(
    target_node: &str,
    seed_node: &str,
    steps: &[EvidenceStep],
) -> String {
    if steps.is_empty() {
        return format!(
            "{} is directly affected by change at {}",
            format_node_label(target_node),
            format_node_label(seed_node)
        );
    }

    let mut parts = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let from_lbl = format_node_label(&step.from_node);
        let to_lbl = format_node_label(&step.to_node);
        let verb = format_edge_verb(step.edge_kind);
        if i == 0 {
            parts.push(format!("{} {} {}", from_lbl, verb, to_lbl));
        } else {
            parts.push(format!("which {} {}", verb, to_lbl));
        }
    }

    format!(
        "{} is impacted because: {}",
        format_node_label(target_node),
        parts.join(", ")
    )
}
