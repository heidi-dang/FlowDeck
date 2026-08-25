use crate::protocol::{AssuranceLevel, EvidenceRef};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Deleted,
    Modified,
    Renamed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticChangeKind {
    FileAdded,
    FileDeleted,
    FileRenamed,

    SymbolAdded,
    SymbolDeleted,
    SymbolChanged,

    SignatureChanged,
    VisibilityChanged,
    TypeChanged,
    ImplementationChanged,

    ImportChanged,
    ExportChanged,
    DependencyChanged,

    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeSubject {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticChange {
    pub id: String,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    pub change_kind: SemanticChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<ChangeSubject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<ChangeSubject>,
    #[serde(default)]
    pub evidence: Vec<EvidenceRef>,
    pub assurance: AssuranceLevel,
    #[serde(default)]
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeSet {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
    pub changes: Vec<SemanticChange>,
    pub assurance: AssuranceLevel,
    pub uncertainty: Vec<crate::intelligence::change::uncertainty::UncertaintyReason>,
}
