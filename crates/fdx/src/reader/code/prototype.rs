use crate::reader::code::languages::{detect_language, get_language_provider};
use crate::reader::code::Symbol;
use std::path::Path;
use tree_sitter::Node;

/// Container node types that can hold child symbols (methods, nested items).
const CONTAINER_KINDS: &[&str] = &[
    "class_declaration",
    "struct_item",
    "impl_item",
    "trait_item",
    "module",
    "namespace_definition",
    "interface_declaration",
];

fn unwrap_export(node: Node<'_>) -> Node<'_> {
    if node.kind() == "export_statement" || node.kind() == "export_default_declaration" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "function_declaration"
                | "class_declaration"
                | "interface_declaration"
                | "lexical_declaration"
                | "type_alias_declaration"
                | "enum_declaration" => return child,
                _ => {}
            }
        }
    }
    node
}

fn collect_container_members(node: Node<'_>) -> Vec<Node<'_>> {
    let mut members = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "class_body" | "interface_body" | "enum_body" | "declaration_list" => {
                let mut body_cursor = child.walk();
                for member in child.children(&mut body_cursor) {
                    members.push(member);
                }
            }
            _ => {
                members.push(child);
            }
        }
    }
    members
}

/// Find symbols in an AST, computing parent scope for each symbol.
/// Returns (node, kind, name, parent_scope).
pub fn find_symbols_in_tree<'a>(
    tree: &'a tree_sitter::Tree,
    source: &str,
    symbol_types: &[&str],
) -> Vec<(Node<'a>, String, String, String)> {
    let root = tree.root_node();
    let mut results = Vec::new();
    let mut cursor = root.walk();

    for raw_child in root.children(&mut cursor) {
        let child = unwrap_export(raw_child);
        let kind = child.kind();
        if CONTAINER_KINDS.contains(&kind) {
            // Container: extract its name, then extract child symbols
            if let Some(name) = extract_symbol_name(child, source) {
                let mapped_kind = map_kind(kind);
                let parent_scope = format!("{}:{}", mapped_kind, name);
                // Add the container itself as a symbol
                if symbol_types.contains(&kind) {
                    results.push((
                        child,
                        mapped_kind.clone(),
                        name.clone(),
                        "module:top".to_string(),
                    ));
                }
                // Extract child symbols with parent scope
                for grandchild in collect_container_members(child) {
                    let gkind = grandchild.kind();
                    if symbol_types.contains(&gkind) {
                        if let Some(gname) = extract_symbol_name(grandchild, source) {
                            results.push((
                                grandchild,
                                map_kind(gkind),
                                gname,
                                parent_scope.clone(),
                            ));
                        }
                    }
                }
            }
        } else if symbol_types.contains(&kind) {
            // Top-level non-container symbol
            if let Some(name) = extract_symbol_name(child, source) {
                results.push((child, map_kind(kind), name, "module:top".to_string()));
            }
        }
    }

    results
}

/// Extract the name of a symbol node.
pub fn extract_symbol_name(node: Node, source: &str) -> Option<String> {
    let mut cursor = node.walk();

    for child in node.children(&mut cursor) {
        match child.kind() {
            "identifier" | "type_identifier" | "property_identifier" => {
                return Some(node_text(child, source));
            }
            _ => {}
        }
    }
    None
}

/// Extract the signature (declaration without body) of a symbol.
pub fn extract_signature(node: Node, source: &str) -> String {
    let start_byte = node.start_byte();
    let end_byte = find_child_by_kind(node, "block")
        .or_else(|| find_child_by_kind(node, "class_body"))
        .or_else(|| find_child_by_kind(node, "interface_body"))
        .or_else(|| find_child_by_kind(node, "enum_body"))
        .or_else(|| find_child_by_kind(node, "function_body"))
        .map(|n| n.start_byte())
        .unwrap_or(node.end_byte());

    let signature_text = &source[start_byte..end_byte];
    signature_text
        .lines()
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(['{', '('])
        .trim()
        .to_string()
}

/// Extract doc comment immediately preceding a symbol.
pub fn extract_doc_comment(node: Node, source: &str) -> Option<String> {
    let start_line = node.start_position().row;
    let lines: Vec<&str> = source.lines().collect();
    let mut doc_lines = Vec::new();

    for i in (0..start_line).rev() {
        let line = lines.get(i)?;
        let trimmed = line.trim();

        if trimmed.starts_with("///") {
            doc_lines.push(trimmed.trim_start_matches("///").trim().to_string());
        } else if trimmed.starts_with("//") {
            doc_lines.push(trimmed.trim_start_matches("//").trim().to_string());
        } else if trimmed.starts_with("#") {
            doc_lines.push(trimmed.trim_start_matches("#").trim().to_string());
        } else if trimmed.starts_with("/*") && trimmed.ends_with("*/") {
            let inner = trimmed
                .trim_start_matches("/*")
                .trim_end_matches("*/")
                .trim();
            doc_lines.push(inner.to_string());
            break;
        } else if trimmed.is_empty() {
            continue;
        } else {
            break;
        }
    }

    if doc_lines.is_empty() {
        return None;
    }

    doc_lines.reverse();
    Some(doc_lines.join("\n"))
}

/// Find a child node by its kind.
#[allow(clippy::manual_find)]
pub fn find_child_by_kind<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == kind {
            return Some(child);
        }
    }
    None
}

/// Get the text of a node from the source.
pub fn node_text(node: Node, source: &str) -> String {
    source[node.start_byte()..node.end_byte()].to_string()
}

/// Map tree-sitter node kind to our symbol kind.
pub fn map_kind(ts_kind: &str) -> String {
    match ts_kind {
        "function_item" | "function_declaration" | "function_definition" | "function_signature" => {
            "function".to_string()
        }
        "method_definition" | "method_signature" => "method".to_string(),
        "struct_item" | "struct_declaration" | "class_declaration" | "class_definition" => {
            "class".to_string()
        }
        "enum_item" | "enum_declaration" | "enum_definition" => "enum".to_string(),
        "trait_item" | "trait_declaration" => "trait".to_string(),
        "interface_declaration" | "interface_definition" => "interface".to_string(),
        "type_item" | "type_alias_declaration" => "type".to_string(),
        "const_item" | "const_declaration" => "const".to_string(),
        "static_item" | "static_declaration" => "static".to_string(),
        "macro_definition" => "macro".to_string(),
        "impl_item" => "impl".to_string(),
        _ => ts_kind.to_string(),
    }
}

pub struct PrototypeReader;

impl Default for PrototypeReader {
    fn default() -> Self {
        Self::new()
    }
}

impl PrototypeReader {
    pub fn new() -> Self {
        Self
    }

    pub fn extract_prototypes(
        &self,
        path: &Path,
        source: &str,
        tree: &tree_sitter::Tree,
    ) -> anyhow::Result<Vec<Symbol>> {
        let provider = detect_language(path)
            .or_else(|| {
                path.extension()
                    .and_then(|e| e.to_str())
                    .and_then(get_language_provider)
            })
            .ok_or_else(|| anyhow::anyhow!("Unsupported language for prototype extraction"))?;

        let found = find_symbols_in_tree(tree, source, &provider.symbol_node_types);
        let mut symbols = Vec::new();

        for (node, kind, name, parent_scope) in found {
            let signature = extract_signature(node, source);
            let doc_comment = extract_doc_comment(node, source);
            let line_start = node.start_position().row + 1;
            let line_end = node.end_position().row + 1;

            symbols.push(Symbol {
                kind,
                name,
                signature,
                doc_comment,
                line_start,
                line_end,
                body: None,
                parent_scope,
            });
        }

        Ok(symbols)
    }
}
