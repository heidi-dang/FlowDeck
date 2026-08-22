//! SCIP protocol model (subset of the canonical scip.proto).
//!
//! Field numbers below mirror
//! <https://github.com/sourcegraph/scip/blob/main/scip.proto>. Only the
//! messages FDX ingests are modeled; unknown fields are skipped during decode
//! for forward compatibility, and unknown wire types fail closed.

/// A decoded SCIP index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScipIndex {
    pub metadata: Option<ScipMetadata>,
    pub documents: Vec<ScipDocument>,
    pub external_symbols: Vec<ScipSymbolInformation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScipMetadata {
    pub version: u32,
    pub tool_info: Option<ScipToolInfo>,
    pub project_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScipToolInfo {
    pub name: String,
    pub version: Option<String>,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScipDocument {
    pub language: String,
    pub relative_path: String,
    pub occurrences: Vec<ScipOccurrence>,
    pub symbols: Vec<ScipSymbolInformation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScipSymbolInformation {
    pub symbol: String,
    pub kind: u32,
    pub display_name: Option<String>,
    pub relationships: Vec<ScipRelationship>,
    pub enclosing_symbol: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScipRelationship {
    pub symbol: String,
    pub is_reference: bool,
    pub is_implementation: bool,
    pub is_definition: bool,
}

/// SCIP SymbolRole bitset values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SymbolRoles(pub u32);

impl SymbolRoles {
    pub const DEFINITION: u32 = 0x1;
    pub const IMPORT: u32 = 0x2;
    pub const GENERATED: u32 = 0x10;
    pub const TEST: u32 = 0x20;

    pub fn is_definition(self) -> bool {
        self.0 & Self::DEFINITION != 0
    }
    pub fn is_import(self) -> bool {
        self.0 & Self::IMPORT != 0
    }
    pub fn is_generated(self) -> bool {
        self.0 & Self::GENERATED != 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScipOccurrence {
    pub symbol: String,
    pub symbol_roles: SymbolRoles,
    /// Deprecated-format range, or a typed-range normalized to this shape.
    pub range: Option<ScipRange>,
}

/// Half-open source range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScipRange {
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
}

/// Whether a symbol is local to its document (local symbol-id form).
pub fn is_local_symbol(symbol: &str) -> bool {
    symbol.starts_with("local ") || symbol == "local"
}

impl ScipIndex {
    pub fn document_count(&self) -> usize {
        self.documents.len()
    }

    pub fn occurrence_count(&self) -> usize {
        self.documents.iter().map(|d| d.occurrences.len()).sum()
    }
}
