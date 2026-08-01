//! Symbol index

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Symbol kind
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SymbolKind {
    Function,
    Class,
    Struct,
    Trait,
    Interface,
    Enum,
    Method,
    Field,
    Type,
    Module,
    Constant,
    Variable,
}

/// Symbol location
#[derive(Debug, Clone)]
pub struct SymbolLocation {
    pub file: PathBuf,
    pub line: usize,
    pub column: usize,
    pub end_line: Option<usize>,
}

/// Indexed symbol
#[derive(Debug, Clone)]
pub struct IndexedSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub location: SymbolLocation,
    pub scope: Option<String>,
    pub signature: Option<String>,
}

/// Symbol index for fast symbol lookups
pub struct SymbolIndex {
    /// Global symbol map (name -> symbols)
    by_name: Arc<RwLock<HashMap<String, Vec<IndexedSymbol>>>>,
    /// File to symbol map (for incremental updates)
    by_file: Arc<RwLock<HashMap<PathBuf, Vec<String>>>>,
    /// Symbol kind index (kind -> symbols)
    by_kind: Arc<RwLock<HashMap<SymbolKind, HashSet<String>>>>,
}

impl SymbolIndex {
    pub fn new() -> Self {
        Self {
            by_name: Arc::new(RwLock::new(HashMap::new())),
            by_file: Arc::new(RwLock::new(HashMap::new())),
            by_kind: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Add a symbol
    pub fn add(&self, symbol: IndexedSymbol) {
        let name = symbol.name.clone();
        let kind = symbol.kind.clone();
        let file = symbol.location.file.clone();

        // Add to name index
        {
            let mut by_name = self.by_name.write().unwrap();
            by_name.entry(name.clone()).or_insert_with(Vec::new).push(symbol.clone());
        }

        // Add to file index
        {
            let mut by_file = self.by_file.write().unwrap();
            by_file
                .entry(file.clone())
                .or_insert_with(Vec::new)
                .push(name.clone());
        }

        // Add to kind index
        {
            let mut by_kind = self.by_kind.write().unwrap();
            by_kind.entry(kind).or_insert_with(HashSet::new).insert(name);
        }
    }

    /// Remove symbols for a file (for incremental updates)
    pub fn remove_file(&self, file: &Path) {
        let mut by_name = self.by_name.write().unwrap();
        let mut by_file = self.by_file.write().unwrap();
        let mut by_kind = self.by_kind.write().unwrap();

        if let Some(symbol_names) = by_file.remove(file) {
            for name in symbol_names {
                // Remove from name index
                if let Some(symbols) = by_name.get_mut(&name) {
                    symbols.retain(|s| s.location.file != file);
                    if symbols.is_empty() {
                        by_name.remove(&name);
                        // Remove from kind index
                        for kind_symbols in by_kind.values_mut() {
                            kind_symbols.remove(&name);
                        }
                    }
                }
            }
        }
    }

    /// Search symbols by name pattern
    pub fn search(&self, pattern: &str) -> Vec<IndexedSymbol> {
        let by_name = self.by_name.read().unwrap();
        let pattern_lower = pattern.to_lowercase();

        by_name
            .values()
            .flatten()
            .filter(|s| s.name.to_lowercase().contains(&pattern_lower))
            .cloned()
            .collect()
    }

    /// Get symbols by kind
    pub fn by_kind(&self, kind: &SymbolKind) -> Vec<IndexedSymbol> {
        let by_name = self.by_name.read().unwrap();
        let by_kind = self.by_kind.read().unwrap();

        if let Some(names) = by_kind.get(kind) {
            names
                .iter()
                .filter_map(|name| by_name.get(name).map(|v| v.clone()))
                .flatten()
                .collect()
        } else {
            Vec::new()
        }
    }

    /// Get symbols in a file
    pub fn in_file(&self, file: &Path) -> Vec<IndexedSymbol> {
        let by_name = self.by_name.read().unwrap();
        let by_file = self.by_file.read().unwrap();

        if let Some(names) = by_file.get(file) {
            names
                .iter()
                .filter_map(|name| by_name.get(name).map(|v| v.clone()))
                .flatten()
                .collect()
        } else {
            Vec::new()
        }
    }

    /// Get all symbols
    pub fn all(&self) -> Vec<IndexedSymbol> {
        let by_name = self.by_name.read().unwrap();
        by_name.values().flatten().cloned().collect()
    }

    /// Clear all symbols
    pub fn clear(&self) {
        let mut by_name = self.by_name.write().unwrap();
        let mut by_file = self.by_file.write().unwrap();
        let mut by_kind = self.by_kind.write().unwrap();
        by_name.clear();
        by_file.clear();
        by_kind.clear();
    }

    /// Total symbol count
    pub fn len(&self) -> usize {
        let by_name = self.by_name.read().unwrap();
        by_name.values().map(|v| v.len()).sum()
    }
}

impl Default for SymbolIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl SymbolKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SymbolKind::Function => "function",
            SymbolKind::Class => "class",
            SymbolKind::Struct => "struct",
            SymbolKind::Trait => "trait",
            SymbolKind::Interface => "interface",
            SymbolKind::Enum => "enum",
            SymbolKind::Method => "method",
            SymbolKind::Field => "field",
            SymbolKind::Type => "type",
            SymbolKind::Module => "module",
            SymbolKind::Constant => "constant",
            SymbolKind::Variable => "variable",
        }
    }
}
