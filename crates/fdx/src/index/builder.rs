//! Building index components from the filesystem.
//!
//! `build_*` functions produce complete components for a repository snapshot.
//! They are used by the cold full build and (via the incremental refresh) by
//! per-file update paths. All functions are deterministic: given the same
//! input tree, they produce the same output ordering.

use crate::index::boundary::{check_file_boundary, verify_post_read, BoundaryVerdict};
use crate::index::components::{
    DependenciesComponent, FilesComponent, GitStateComponent, SymbolsComponent,
    TestMappingComponent,
};
use crate::index::identity::{git_branch, git_detached, git_head_sha};
use crate::index::manifest::{
    normalize_rel_path, symbol_id, DependencyEdge, FileMeta, GitStateSnapshot, SymbolMeta,
    TestMappingRow,
};
use crate::index::storage::sha256_hex;
use crate::reader::code::languages::detect_language;
use crate::reader::code::parser::parse_source;
use crate::reader::code::prototype::find_symbols_in_tree;
use std::collections::BTreeSet;
use std::path::Path;

/// Generation number stamped onto every row built by the cold build.
pub const COLD_GENERATION: u64 = 1;

/// Language classifications.
pub const CLASS_SOURCE: &str = "source";
pub const CLASS_TEST: &str = "test";
pub const CLASS_GENERATED: &str = "generated";
pub const CLASS_BINARY: &str = "binary";
pub const CLASS_IGNORED: &str = "ignored";

/// Whether a relative path is a test file by naming convention.
fn is_test_path(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    lower.contains("_test")
        || lower.contains(".test.")
        || lower.contains(".spec.")
        || lower.contains("/tests/")
        || lower.contains("/test/")
}

/// Whether a relative path looks like a generated file (by name).
fn is_generated_path(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    name.ends_with(".min.js")
        || name.ends_with(".min.css")
        || name.ends_with(".map")
        || name.ends_with(".lock")
        || name == "package-lock.json"
        || name == "yarn.lock"
        || name == "pnpm-lock.yaml"
        || name == "bun.lock"
        || name == "bun.lockb"
}

/// Whether a path is a known binary/text-unsafe extension.
fn is_binary_path(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".pdf", ".zip", ".gz",
        ".tar", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".o", ".obj", ".class", ".jar",
        ".woff", ".woff2", ".ttf", ".otf", ".wasm", ".mp4", ".mp3", ".avi", ".mov",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

/// Detect the language for a relative path ("" for unknown/binary).
pub fn detect_language_for(rel: &str) -> String {
    if is_binary_path(rel) {
        return String::new();
    }
    let path = Path::new(rel);
    detect_language(path)
        .map(|p| p.name.to_string())
        .unwrap_or_default()
}

/// Build the file metadata component by walking `root` with ignore rules.
///
/// `ignore` is an optional `ignore::WalkBuilder` configured by the caller.
/// `max_files` bounds the total number of files indexed (hard cap).
pub fn build_files(
    root: &Path,
    ignored: &ignore::overrides::Override,
    max_files: usize,
) -> FilesComponent {
    let mut files = FilesComponent::default();
    let mut walk = ignore::WalkBuilder::new(root);
    walk.add_custom_ignore_filename(".fdignore");
    walk.overrides(ignored.clone());
    walk.git_ignore(true);
    walk.hidden(true);
    walk.follow_links(false);
    walk.max_depth(Some(64));
    let mut count = 0usize;

    for entry in walk.build() {
        if count >= max_files {
            break;
        }
        let Ok(entry) = entry else { continue };
        let ft = entry.file_type();
        let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            continue;
        }
        let abs = entry.path();
        let Ok(rel) = abs.strip_prefix(root) else {
            continue;
        };
        let rel_str = normalize_rel_path(rel);
        if rel_str.is_empty() {
            continue;
        }
        // Repository boundary enforcement: reject symlinks that escape
        // the canonical repository root and broken/unresolvable entries.
        match check_file_boundary(abs, root) {
            BoundaryVerdict::Allow | BoundaryVerdict::AllowSymlink => {}
            BoundaryVerdict::SymlinkEscape(_) | BoundaryVerdict::Unresolvable => {
                continue;
            }
        }
        // Never index the git metadata directory or VCS internals.
        if rel_str.starts_with(".git/")
            || rel_str == ".git"
            || rel_str.starts_with(".hg/")
            || rel_str.starts_with(".svn/")
        {
            continue;
        }
        let meta = file_meta_from_entry(
            abs,
            root,
            &rel_str,
            is_test_path(&rel_str),
            is_generated_path(&rel_str),
            is_binary_path(&rel_str),
            COLD_GENERATION,
        );
        files.files.insert(rel_str.clone(), meta);
        count += 1;
    }
    files
}

/// Compute a `FileMeta` for one file path.
///
/// `root` is required for the post-read TOCTOU check: after reading content,
/// we verify the file still resolves within `root` so a race that swaps a
/// regular file with an external symlink before read cannot leak content.
fn file_meta_from_entry(
    abs: &Path,
    root: &Path,
    rel: &str,
    is_test: bool,
    is_generated: bool,
    is_binary: bool,
    generation: u64,
) -> FileMeta {
    let meta = std::fs::symlink_metadata(abs)
        .unwrap_or_else(|_| std::fs::metadata(abs).unwrap_or_default_for_file());
    let kind = if meta.file_type().is_symlink() {
        "symlink"
    } else if meta.is_dir() {
        "dir"
    } else {
        "file"
    };
    let size = meta.len();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let executable = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            false
        }
    };
    let classification = if is_binary {
        CLASS_BINARY
    } else if is_generated {
        CLASS_GENERATED
    } else if is_test {
        CLASS_TEST
    } else {
        CLASS_SOURCE
    };
    let content_hash = if is_binary {
        String::new()
    } else {
        // TOCTOU guard: read content, then verify the path still resolves
        // inside root. A symlink swap that occurred between the walk and
        // the read cannot leak external content because we re-validate.
        match std::fs::read(abs) {
            Ok(bytes) if verify_post_read(abs, root) => {
                sha256_hex(&bytes).chars().take(16).collect()
            }
            Ok(_) => String::new(),
            Err(_) => String::new(),
        }
    };
    FileMeta {
        path: rel.to_string(),
        kind: kind.to_string(),
        size,
        modified,
        content_hash,
        language: detect_language_for(rel),
        executable,
        classification: classification.to_string(),
        generation,
    }
}

/// Trait-less helper: default FileMeta used when metadata is unavailable.
trait DefaultFileMeta {
    fn unwrap_or_default_for_file(self) -> std::fs::Metadata;
}

impl DefaultFileMeta for std::io::Result<std::fs::Metadata> {
    fn unwrap_or_default_for_file(self) -> std::fs::Metadata {
        match self {
            Ok(m) => m,
            Err(_) => std::fs::File::open("/dev/null")
                .and_then(|f| f.metadata())
                .unwrap_or_else(|_| dummy_metadata()),
        }
    }
}

fn dummy_metadata() -> std::fs::Metadata {
    // A permissive empty metadata: size 0, not a dir.
    std::fs::File::open("/dev/null")
        .and_then(|f| f.metadata())
        .expect("cannot open /dev/null")
}

/// Build the symbol component for one file. Returns symbols (possibly empty).
pub fn build_symbols_for_file(
    _abs: &Path,
    rel: &str,
    content: &str,
    generation: u64,
) -> Vec<SymbolMeta> {
    let provider = detect_language(Path::new(rel));
    let Some(provider) = provider else {
        return Vec::new();
    };
    let Ok(tree) = parse_source(content, (provider.grammar)()) else {
        return Vec::new();
    };
    let source_hash = sha256_hex(content.as_bytes())
        .chars()
        .take(16)
        .collect::<String>();
    let mut out = Vec::new();

    let symbols = find_symbols_in_tree(&tree, content, &provider.symbol_node_types);
    for (node, mapped_kind, name, parent_scope) in symbols {
        let start = node.start_position().row + 1;
        let end = node.end_position().row + 1;
        // parent_scope is "<kind>:<name>" for containers, "module:top" for
        // top-level. Derive a parent id from it when it is not top-level.
        let parent_id = if parent_scope == "module:top" || !parent_scope.contains(':') {
            String::new()
        } else {
            let parent_name = parent_scope.split_once(':').map(|(_, n)| n).unwrap_or("");
            symbol_id(parent_name, rel)
        };
        let qname = qualified_name(&name, parent_of(&parent_scope));
        out.push(SymbolMeta {
            id: symbol_id(&qname, rel),
            name,
            qualified_name: qname.clone(),
            kind: mapped_kind,
            file: rel.to_string(),
            line_start: start,
            line_end: end,
            exported: is_exported_symbol(&provider.symbol_node_types, &parent_scope),
            parent_id,
            source_hash: source_hash.clone(),
            generation,
        });
    }
    out
}

/// Derive a parent name from a parent_scope "<kind>:<name>".
fn parent_of(parent_scope: &str) -> Option<&str> {
    if parent_scope == "module:top" {
        None
    } else {
        parent_scope
            .split_once(':')
            .map(|(_, n)| n)
            .filter(|n| !n.is_empty())
    }
}

/// Heuristic exported status: symbols under an exported container or
/// top-level symbols are treated as public where detectable.
fn is_exported_symbol(symbol_types: &[&str], parent_scope: &str) -> bool {
    // Symbols nested inside a named container inherit its visibility; we
    // conservatively mark non-top-level members as exported when the
    // container itself looks exported, and top-level symbols as exported.
    parent_scope != "module:top" || !symbol_types.is_empty()
}

/// Compute a qualified name from a symbol name and its parent.
fn qualified_name(name: &str, parent: Option<&str>) -> String {
    match parent {
        Some(p) => format!("{p}::{name}"),
        None => name.to_string(),
    }
}

/// Whether a tree-sitter node kind is exported/public.
#[allow(dead_code)]
fn is_exported(ts_kind: &str) -> bool {
    let k = ts_kind.to_lowercase();
    k.contains("export")
        || k == "pub"
        || k.contains("public")
        || k == "function_declaration"
        || k == "class_declaration"
        || k == "struct_item"
        || k == "enum_item"
        || k == "trait_item"
        || k == "impl_item"
        || k == "interface_declaration"
        || k == "type_alias_declaration"
}

/// Build the symbol component for the whole repo by scanning source files.
pub fn build_symbols(root: &Path, files: &FilesComponent, max_symbols: usize) -> SymbolsComponent {
    let mut comp = SymbolsComponent::default();
    let mut count = 0usize;
    for (rel, meta) in &files.files {
        if count >= max_symbols {
            break;
        }
        if meta.classification == CLASS_BINARY || meta.classification == CLASS_GENERATED {
            continue;
        }
        let abs = root.join(rel);
        let Ok(content) = std::fs::read_to_string(&abs) else {
            continue;
        };
        let syms = build_symbols_for_file(&abs, rel, &content, COLD_GENERATION);
        count += syms.len();
        for sym in syms {
            comp.insert(sym);
        }
    }
    comp
}

/// Build the dependency graph for one file. Uses a lightweight scanner:
/// import/require/module directives per language.
pub fn build_dependencies_for_file(
    rel: &str,
    content: &str,
    generation: u64,
) -> Vec<DependencyEdge> {
    let language = detect_language_for(rel);
    let mut edges = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (spec, kind) in scan_imports(&language, content) {
        let key = format!("{kind}:{spec}");
        if !seen.insert(key) {
            continue;
        }
        let unresolved = !spec.starts_with('.') && !spec.starts_with('/');
        edges.push(DependencyEdge {
            from_file: rel.to_string(),
            to_file: String::new(), // resolved later against the file index
            specifier: spec,
            kind,
            unresolved,
            generation,
        });
    }
    edges
}

/// Scan a source file for import specifiers.
fn scan_imports(language: &str, content: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let lower = language.to_lowercase();
    let quote_patterns: Vec<(&str, &str)> = match lower.as_str() {
        "python" => vec![("import ", "\n"), ("from ", " import")],
        "rust" => vec![("use ", ";")],
        "typescript" | "javascript" | "tsx" | "jsx" => vec![
            ("from '", "'"),
            ("from \"", "\""),
            ("require('", "'"),
            ("require(\"", "\""),
            ("import '", "'"),
            ("import \"", "\""),
        ],
        "java" => vec![("import ", ";")],
        _ => vec![],
    };

    for (needle, terminator) in quote_patterns {
        let mut rest = content;
        while let Some(pos) = rest.find(needle) {
            let after = &rest[pos + needle.len()..];
            let (spec, remaining) = match terminator {
                "\n" | ";" => match after.find(terminator) {
                    Some(end) => (after[..end].trim().to_string(), &after[end..]),
                    None => (after.trim().to_string(), ""),
                },
                _ => {
                    // quoted: find the closing quote
                    let quote = terminator;
                    match after.find(quote) {
                        Some(end) => (after[..end].trim().to_string(), &after[end + quote.len()..]),
                        None => break,
                    }
                }
            };
            let cleaned = spec
                .trim_end_matches(|c: char| c == ',' || c.is_whitespace() || c == '{' || c == '}');
            let kind = if lower == "python" && needle.starts_with("from ") {
                "from"
            } else if lower == "rust" {
                "use"
            } else if needle.contains("require") {
                "require"
            } else {
                "import"
            };
            if !cleaned.is_empty() && !cleaned.contains('{') && !cleaned.starts_with('#') {
                out.push((cleaned.to_string(), kind.to_string()));
            }
            rest = remaining;
            if rest.is_empty() {
                break;
            }
        }
    }
    out
}

/// Resolve relative import specifiers to repository-relative paths.
pub fn resolve_import(
    from_file: &str,
    specifier: &str,
    files: &FilesComponent,
    language: &str,
) -> Option<String> {
    if !specifier.starts_with('.') && !specifier.starts_with('/') {
        return None; // bare module: unresolved
    }
    let from_dir = Path::new(from_file)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let candidate = from_dir.join(specifier);
    let mut try_paths = vec![candidate.clone()];
    // Extension probing for TS/JS.
    if matches!(
        language.to_lowercase().as_str(),
        "typescript" | "javascript" | "tsx" | "jsx"
    ) {
        for ext in [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mjs",
            "/index.ts",
            "/index.js",
        ] {
            let mut p = candidate.clone();
            let pstr = p.to_string_lossy().into_owned();
            if pstr.ends_with(".ts")
                || pstr.ends_with(".js")
                || pstr.ends_with(".tsx")
                || pstr.ends_with(".jsx")
            {
                continue;
            }
            if !ext.starts_with('/') {
                p.set_extension(ext.trim_start_matches('.'));
            } else {
                p.push(ext.trim_start_matches('/'));
            }
            try_paths.push(p);
        }
    }
    for t in try_paths {
        let rel = normalize_rel_path(&t);
        // Strip a leading "./" so the key matches the file index keys.
        let clean = rel.strip_prefix("./").unwrap_or(&rel).to_string();
        if files.files.contains_key(&clean) {
            return Some(clean);
        }
    }
    None
}

/// Build the dependency component for the whole repo.
pub fn build_dependencies(
    root: &Path,
    files: &FilesComponent,
    max_edges: usize,
) -> DependenciesComponent {
    let mut comp = DependenciesComponent::default();
    let mut count = 0usize;
    for (rel, meta) in &files.files {
        if count >= max_edges {
            break;
        }
        if meta.classification != CLASS_SOURCE && meta.classification != CLASS_TEST {
            continue;
        }
        let abs = root.join(rel);
        let Ok(content) = std::fs::read_to_string(&abs) else {
            continue;
        };
        let mut edges = build_dependencies_for_file(rel, &content, COLD_GENERATION);
        let language = meta.language.clone();
        for e in &mut edges {
            if !e.unresolved {
                if let Some(target) = resolve_import(rel, &e.specifier, files, &language) {
                    e.to_file = target;
                    e.unresolved = false;
                } else {
                    e.unresolved = true;
                }
            }
        }
        count += edges.len();
        comp.replace_file(rel, edges);
    }
    comp
}

/// Build the test-to-source mapping.
///
/// Deterministic rules:
/// 1. direct import (test file imports the source file) — confidence 1.0;
/// 2. naming convention (source `x.ts` ↔ test `x.test.ts`) — confidence 0.8;
/// 3. configured test roots are handled by the caller via `extra_roots`.
pub fn build_test_mapping(
    files: &FilesComponent,
    deps: &DependenciesComponent,
) -> TestMappingComponent {
    let mut comp = TestMappingComponent::default();
    let mut test_files: Vec<String> = files
        .files
        .values()
        .filter(|m| m.classification == CLASS_TEST)
        .map(|m| m.path.clone())
        .collect();
    test_files.sort_unstable();

    for test in &test_files {
        // Rule 1: direct imports.
        for e in deps.edges_from(test) {
            if !e.unresolved && !e.to_file.is_empty() {
                comp.insert(TestMappingRow {
                    source_file: e.to_file.clone(),
                    test_file: test.clone(),
                    basis: "direct_import".to_string(),
                    confidence: 1.0,
                });
            }
        }
        // Rule 2: naming convention.
        let stem = test
            .trim_end_matches(".test.ts")
            .trim_end_matches(".spec.ts")
            .trim_end_matches(".test.js")
            .trim_end_matches(".spec.js")
            .trim_end_matches("_test.rs")
            .trim_end_matches("_test.py")
            .trim_end_matches(".test.go");
        if stem != test && !stem.is_empty() {
            let source = format!("{stem}{}", source_extension(test));
            if files.files.contains_key(&source) {
                comp.insert(TestMappingRow {
                    source_file: source.clone(),
                    test_file: test.clone(),
                    basis: "naming".to_string(),
                    confidence: 0.8,
                });
            }
        }
    }
    comp
}

/// Guess the source extension for a test file (for naming mapping).
fn source_extension(test: &str) -> &str {
    if test.ends_with(".test.ts") || test.ends_with(".spec.ts") {
        ".ts"
    } else if test.ends_with(".test.js") || test.ends_with(".spec.js") {
        ".js"
    } else if test.ends_with("_test.rs") {
        ".rs"
    } else if test.ends_with("_test.py") {
        ".py"
    } else if test.ends_with(".test.go") {
        ".go"
    } else {
        ".ts"
    }
}

/// Build the git state snapshot.
pub fn build_git_state(
    root: &Path,
    files: &FilesComponent,
    worktree_id: &str,
    generation: u64,
) -> GitStateComponent {
    let mut snap = GitStateSnapshot {
        head_sha: git_head_sha(root),
        branch: git_branch(root),
        detached: git_detached(root),
        worktree_id: worktree_id.to_string(),
        generation,
        ..Default::default()
    };
    if snap.head_sha.is_empty() {
        // Not a git repo: treat all files as untracked (policy).
        snap.untracked_files = files.files.keys().cloned().collect();
        snap.untracked_files.sort_unstable();
        return GitStateComponent { snapshot: snap };
    }
    // Tracked changes from git status --porcelain=v1 -z (NUL-delimited).
    // The NUL-delimited format safely handles special-character paths
    // (spaces, quotes, tabs, newlines, Unicode). Never parse human-oriented
    // quoted output.
    if let Ok(out) = std::process::Command::new("git")
        .args(["status", "--porcelain=v1", "-z", "--no-renames"])
        .current_dir(root)
        .output()
    {
        let stdout = &out.stdout;
        let mut changed = BTreeSet::new();
        let mut deleted = BTreeSet::new();
        let mut untracked = BTreeSet::new();

        // NUL-delimited: each record is "<XY> <path>\0"
        for record in stdout.split(|b| *b == 0) {
            if record.len() < 4 {
                continue;
            }
            let status_str = std::str::from_utf8(&record[0..2]).unwrap_or("");
            let path = std::str::from_utf8(&record[3..]).unwrap_or("").trim();
            if path.is_empty() {
                continue;
            }
            match status_str {
                "??" => {
                    untracked.insert(path.to_string());
                }
                s if s.starts_with('D') || s.ends_with('D') => {
                    deleted.insert(path.to_string());
                }
                _ => {
                    changed.insert(path.to_string());
                }
            }
        }
        snap.changed_files = changed.into_iter().collect();
        snap.deleted_files = deleted.into_iter().collect();
        snap.untracked_files = untracked.into_iter().collect();
    }
    GitStateComponent { snapshot: snap }
}
