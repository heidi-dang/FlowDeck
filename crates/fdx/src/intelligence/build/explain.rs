//! Explainability rendering helpers for build and configuration evidence paths.

use crate::protocol::EdgeKind;

pub fn format_build_hop(from_node: &str, edge_kind: EdgeKind, to_node: &str) -> String {
    let from_clean = clean_node_id(from_node);
    let to_clean = clean_node_id(to_node);
    match edge_kind {
        EdgeKind::Extends => format!("{} extends {}", from_clean, to_clean),
        EdgeKind::References => format!("{} references {}", from_clean, to_clean),
        EdgeKind::Configures => format!("{} configures {}", from_clean, to_clean),
        EdgeKind::Contains => format!("{} contains {}", from_clean, to_clean),
        EdgeKind::DependsOn => format!("{} depends on {}", from_clean, to_clean),
        EdgeKind::BelongsTo => format!("{} belongs to {}", from_clean, to_clean),
        EdgeKind::Reads => format!("{} reads {}", from_clean, to_clean),
        EdgeKind::Uses => format!("{} uses {}", from_clean, to_clean),
        EdgeKind::Generates => format!("{} generates {}", from_clean, to_clean),
        _ => format!("{} {:?} {}", from_clean, edge_kind, to_clean),
    }
}

fn clean_node_id(id: &str) -> &str {
    if let Some(s) = id.strip_prefix("config:") {
        s
    } else if let Some(s) = id.strip_prefix("pkg:") {
        s
    } else if let Some(s) = id.strip_prefix("build:") {
        s
    } else if let Some(s) = id.strip_prefix("workspace:") {
        s
    } else if let Some(s) = id.strip_prefix("file:") {
        s
    } else {
        id
    }
}
