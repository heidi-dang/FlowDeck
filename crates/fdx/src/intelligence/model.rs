use crate::protocol::{EdgeKind, EvidenceProviderKind, EvidenceStrength, NodeKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexedFile {
    pub canonical_path: String,
    pub content_hash: String,
    pub size: u64,
    pub mtime_ms: Option<u64>,
    pub language: Option<String>,
    pub indexed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphNode {
    pub stable_id: String,
    pub kind: NodeKind,
    pub canonical_path: Option<String>,
    pub symbol_identity: Option<String>,
    pub package_identity: Option<String>,
    pub metadata: Option<String>,
    pub source_identity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphEdge {
    pub stable_id: String,
    pub from_node: String,
    pub to_node: String,
    pub kind: EdgeKind,
    pub provider: EvidenceProviderKind,
    pub provider_fingerprint: String,
    pub strength: EvidenceStrength,
    pub source_identity: Option<String>,
    pub source_hash: Option<String>,
    pub created_revision: u64,
    pub updated_revision: u64,
    pub stale: bool,
}
/// A provider-owned semantic node with full provenance. Mirrors GraphNode
/// plus ownership fields; provider derivation is never ambiguous with
/// file-owned structural nodes (provider == None).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticNode {
    pub stable_id: String,
    pub kind: NodeKind,
    pub canonical_path: Option<String>,
    pub symbol_identity: Option<String>,
    pub package_identity: Option<String>,
    pub metadata: Option<String>,
    pub provider: String,
    pub provider_fingerprint: String,
    pub generation: u64,
    pub source_identity: Option<String>,
    pub source_hash: Option<String>,
}

/// A provider-owned semantic edge with generation + occurrence metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticEdge {
    pub stable_id: String,
    pub from_node: String,
    pub to_node: String,
    pub kind: EdgeKind,
    pub provider: EvidenceProviderKind,
    pub provider_fingerprint: String,
    pub strength: EvidenceStrength,
    pub source_identity: Option<String>,
    pub source_hash: Option<String>,
    pub generation: u64,
    /// JSON array of occurrence positions (kept out of the stable id so edge
    /// identity survives harmless location changes).
    pub metadata: Option<String>,
}
