//! Tree-sitter degraded local fallback for reference queries.
//!
//! Used when fresh SCIP evidence is unavailable, stale, or failed. Output is
//! explicit structural evidence: provenance Strength::Structural, never
//! labeled SCIP/Precise/Complete.

use crate::intelligence::semantic::LanguageId;
use crate::reader::code::languages::detect_language;
use crate::reader::code::parser::parse_source;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FallbackReference {
    pub name: String,
    pub canonical_path: String,
    /// 1-based line number.
    pub start_line: u32,
    pub start_character: u32,
    pub end_character: u32,
    pub role: FallbackRole,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackRole {
    Definition,
    Reference,
}

impl FallbackRole {
    pub fn as_str(self) -> &'static str {
        match self {
            FallbackRole::Definition => "definition",
            FallbackRole::Reference => "reference",
        }
    }
}

/// Hard bounds for the structural sweep (bounded files, bounded matches).
pub const MAX_FALLBACK_FILES: usize = 500;
pub const MAX_FALLBACK_MATCHES: usize = 5000;
pub const MAX_FALLBACK_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Collect structural definition/reference occurrences of `symbol_name` for
/// `lang` across the repository (bounded walk + bounded parse).
pub fn structural_references(
    repo_root: &Path,
    lang: LanguageId,
    symbol_name: &str,
) -> Result<Vec<FallbackReference>, FallbackError> {
    let mut results: Vec<FallbackReference> = Vec::new();
    let mut files_processed = 0usize;
    let mut stack = vec![repo_root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        visited += 1;
        if visited > 100_000 {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.components().any(|c| {
                c.as_os_str() == ".git"
                    || c.as_os_str() == ".fdx"
                    || c.as_os_str() == "target"
                    || c.as_os_str() == "node_modules"
            }) {
                continue;
            }
            if results.len() >= MAX_FALLBACK_MATCHES {
                return Ok(results);
            }
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if files_processed >= MAX_FALLBACK_FILES {
                return Ok(results);
            }
            let ext_ok = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| lang.extensions().contains(&e))
                .unwrap_or(false);
            if !ext_ok {
                continue;
            }
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > MAX_FALLBACK_FILE_BYTES {
                continue;
            }
            let source = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let provider = match detect_language(&path) {
                Some(p) => p,
                None => continue,
            };
            let canonical = match crate::protocol::canonicalize_repo_path(&path, repo_root) {
                Ok(c) => c,
                Err(_) => continue,
            };
            files_processed += 1;
            let tree = match parse_source(&source, (provider.grammar)()) {
                Ok(t) => t,
                Err(_) => continue,
            };
            collect_for_tree(
                &tree,
                &source,
                &canonical,
                symbol_name,
                &provider.symbol_node_types,
                &mut results,
                0,
            );
        }
    }
    Ok(results)
}

fn collect_for_tree(
    tree: &tree_sitter::Tree,
    source: &str,
    canonical: &str,
    symbol_name: &str,
    definition_node_types: &[&str],
    results: &mut Vec<FallbackReference>,
    depth: usize,
) {
    if depth > 300 || results.len() >= MAX_FALLBACK_MATCHES {
        return;
    }
    walk(
        tree.root_node(),
        source,
        canonical,
        symbol_name,
        definition_node_types,
        results,
        depth,
    );
}

#[allow(clippy::only_used_in_recursion)]
fn walk(
    node: tree_sitter::Node,
    source: &str,
    canonical: &str,
    symbol_name: &str,
    definition_node_types: &[&str],
    results: &mut Vec<FallbackReference>,
    depth: usize,
) {
    if results.len() >= MAX_FALLBACK_MATCHES {
        return;
    }
    if node.is_named() && node.kind() == "identifier" {
        if let Ok(text) = node.utf8_text(source.as_bytes()) {
            if text == symbol_name {
                let role = classify_role(node, definition_node_types);
                let pos = node.start_position();
                let end = node.end_position();
                results.push(FallbackReference {
                    name: symbol_name.to_string(),
                    canonical_path: canonical.to_string(),
                    start_line: (pos.row + 1) as u32,
                    start_character: pos.column as u32,
                    end_character: end.column as u32,
                    role,
                });
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(
            child,
            source,
            canonical,
            symbol_name,
            definition_node_types,
            results,
            depth + 1,
        );
    }
}

/// Classify: the identifier is a definition when it is the name field of a
/// definition-node type for the language.
fn classify_role(node: tree_sitter::Node, definition_node_types: &[&str]) -> FallbackRole {
    if let Some(parent) = node.parent() {
        let is_defn_type = definition_node_types.contains(&parent.kind());
        let is_name_field = parent
            .child_by_field_name("name")
            .map(|n| n.id() == node.id())
            .unwrap_or(false);
        if is_defn_type && is_name_field {
            return FallbackRole::Definition;
        }
    }
    FallbackRole::Reference
}

#[derive(Debug, thiserror::Error)]
pub enum FallbackError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_definition_and_reference_in_rust_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(
            dir.path().join("src/lib.rs"),
            "pub fn area(w: u32, h: u32) -> u32 {\n    w * h\n}\nfn other() {\n    let a = area(2, 3);\n}\n",
        )
        .unwrap();
        let refs = structural_references(dir.path(), LanguageId::Rust, "area").unwrap();
        let has_definition = refs.iter().any(|r| r.role == FallbackRole::Definition);
        let has_reference = refs.iter().any(|r| r.role == FallbackRole::Reference);
        assert!(has_definition, "expected a definition, got {:?}", refs);
        assert!(has_reference, "expected a reference, got {:?}", refs);
    }

    #[test]
    fn empty_for_unknown_symbol() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/lib.rs"), "pub fn area() {}\n").unwrap();
        let refs = structural_references(dir.path(), LanguageId::Rust, "nope").unwrap();
        assert!(refs.is_empty());
    }
}
