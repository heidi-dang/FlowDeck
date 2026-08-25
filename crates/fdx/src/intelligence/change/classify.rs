//! Semantic change classification for repository deltas.
//!
//! Classifies Git deltas into structured, typed semantic changes:
//! - FileAdded, FileDeleted, FileRenamed
//! - SymbolAdded, SymbolDeleted, SymbolChanged
//! - SignatureChanged, VisibilityChanged, TypeChanged, ImplementationChanged
//! - Unknown (for unsupported languages / unparseable code)
//!
//! Provenance, evidence strength, and uncertainty triggers are explicitly recorded.

use crate::intelligence::change::model::{
    ChangeKind, ChangeSet, ChangeSubject, SemanticChange, SemanticChangeKind,
};
use crate::intelligence::change::uncertainty::{
    assurance_ceiling_for_evidence, combine_assurance, UncertaintyReason,
};
use crate::protocol::{
    canonicalize_repo_path, AssuranceLevel, EvidenceProviderKind, EvidenceRef, EvidenceStrength,
    FreshnessMetadata,
};
use crate::reader::code::languages::detect_language;
use crate::reader::code::parser::parse_source;
use crate::reader::code::prototype::{
    extract_signature, find_child_by_kind, find_symbols_in_tree, node_text,
};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ClassifyError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Git error: {0}")]
    Git(String),
    #[error("Path escape error: {0}")]
    PathEscape(String),
    #[error("Parse error: {0}")]
    Parse(String),
}

#[derive(Debug, Clone)]
pub struct RawGitChange {
    pub kind: ChangeKind,
    pub path: String,
    pub old_path: Option<String>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Compute a stable, deterministic change ID that does NOT depend on line numbers.
pub fn compute_change_id(
    file: &str,
    symbol: Option<&str>,
    kind: SemanticChangeKind,
    before_digest: Option<&str>,
    after_digest: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(file.as_bytes());
    hasher.update(b":");
    if let Some(s) = symbol {
        hasher.update(s.as_bytes());
    }
    hasher.update(b":");
    hasher.update(format!("{:?}", kind).as_bytes());
    hasher.update(b":");
    if let Some(b) = before_digest {
        hasher.update(b.as_bytes());
    }
    hasher.update(b":");
    if let Some(a) = after_digest {
        hasher.update(a.as_bytes());
    }
    let hex = format!("{:x}", hasher.finalize());
    format!("ch_{}", &hex[..24])
}

/// Run a git command safely with direct argv and check exit status.
fn run_git_bytes(repo_root: &Path, args: &[&str]) -> Result<Vec<u8>, ClassifyError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output()
        .map_err(|e| ClassifyError::Git(format!("Failed to spawn git: {}", e)))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(ClassifyError::Git(format!(
            "git command failed (args: {:?}): {}",
            args,
            err_msg.trim()
        )));
    }
    Ok(output.stdout)
}

/// Read file content from Git ref (e.g. HEAD, HEAD~1, or commit hash).
pub fn read_git_file_content(repo_root: &Path, git_ref: &str, repo_path: &str) -> Option<String> {
    let spec = format!("{}:{}", git_ref, repo_path);
    let output = Command::new("git")
        .args(["show", &spec])
        .current_dir(repo_root)
        .output()
        .ok()?;

    if output.status.success() {
        String::from_utf8(output.stdout).ok()
    } else {
        None
    }
}

/// Collect raw file changes via safe NUL-separated git diff.
pub fn collect_git_deltas(
    repo_root: &Path,
    base_ref: Option<&str>,
    head_ref: Option<&str>,
) -> Result<Vec<RawGitChange>, ClassifyError> {
    let mut changes = Vec::new();
    let base = base_ref.unwrap_or("HEAD");

    let mut args = vec!["diff", "--name-status", "-z", "-M"];
    args.push(base);
    if let Some(head) = head_ref {
        args.push(head);
    }

    let diff_output = run_git_bytes(repo_root, &args)?;
    let mut idx = 0;
    while idx < diff_output.len() {
        // Read status string until NUL
        let status_end = diff_output[idx..]
            .iter()
            .position(|&b| b == 0)
            .map(|p| idx + p)
            .unwrap_or(diff_output.len());
        let status_str = String::from_utf8_lossy(&diff_output[idx..status_end]);
        idx = status_end + 1;
        if idx >= diff_output.len() {
            break;
        }

        if status_str.starts_with('R') {
            // Rename has two paths: old_path and new_path
            let old_end = diff_output[idx..]
                .iter()
                .position(|&b| b == 0)
                .map(|p| idx + p)
                .unwrap_or(diff_output.len());
            let old_raw = String::from_utf8_lossy(&diff_output[idx..old_end]).to_string();
            idx = old_end + 1;
            if idx >= diff_output.len() {
                break;
            }

            let new_end = diff_output[idx..]
                .iter()
                .position(|&b| b == 0)
                .map(|p| idx + p)
                .unwrap_or(diff_output.len());
            let new_raw = String::from_utf8_lossy(&diff_output[idx..new_end]).to_string();
            idx = new_end + 1;

            let old_canon = canonicalize_repo_path(Path::new(&old_raw), repo_root)
                .map_err(|e| ClassifyError::PathEscape(e.to_string()))?;
            let new_canon = canonicalize_repo_path(Path::new(&new_raw), repo_root)
                .map_err(|e| ClassifyError::PathEscape(e.to_string()))?;

            changes.push(RawGitChange {
                kind: ChangeKind::Renamed,
                path: new_canon,
                old_path: Some(old_canon),
            });
        } else {
            let path_end = diff_output[idx..]
                .iter()
                .position(|&b| b == 0)
                .map(|p| idx + p)
                .unwrap_or(diff_output.len());
            let raw_path = String::from_utf8_lossy(&diff_output[idx..path_end]).to_string();
            idx = path_end + 1;

            let canon = canonicalize_repo_path(Path::new(&raw_path), repo_root)
                .map_err(|e| ClassifyError::PathEscape(e.to_string()))?;

            if canon.starts_with(".fdx")
                || canon.starts_with(".git")
                || canon.starts_with("target")
                || canon.starts_with("node_modules")
            {
                continue;
            }

            let kind = if status_str.starts_with('A') || status_str.starts_with('C') {
                ChangeKind::Added
            } else if status_str.starts_with('D') {
                ChangeKind::Deleted
            } else {
                ChangeKind::Modified
            };

            changes.push(RawGitChange {
                kind,
                path: canon,
                old_path: None,
            });
        }
    }

    // If comparing against working tree (head_ref is None), also check untracked files
    if head_ref.is_none() {
        if let Ok(untracked_bytes) = run_git_bytes(
            repo_root,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        ) {
            let mut u_idx = 0;
            while u_idx < untracked_bytes.len() {
                let end = untracked_bytes[u_idx..]
                    .iter()
                    .position(|&b| b == 0)
                    .map(|p| u_idx + p)
                    .unwrap_or(untracked_bytes.len());
                let raw_u = String::from_utf8_lossy(&untracked_bytes[u_idx..end]).to_string();
                u_idx = end + 1;
                if raw_u.trim().is_empty() {
                    continue;
                }
                if let Ok(canon) = canonicalize_repo_path(Path::new(&raw_u), repo_root) {
                    if canon.starts_with(".fdx")
                        || canon.starts_with(".git")
                        || canon.starts_with("target")
                        || canon.starts_with("node_modules")
                    {
                        continue;
                    }
                    if !changes.iter().any(|c| c.path == canon) {
                        changes.push(RawGitChange {
                            kind: ChangeKind::Added,
                            path: canon,
                            old_path: None,
                        });
                    }
                }
            }
        }
    }

    Ok(changes)
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StructuralSymbolKey {
    pub parent_scope: String,
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct ParsedSymbolInfo {
    pub key: StructuralSymbolKey,
    pub name: String,
    #[allow(dead_code)]
    pub kind: String,
    pub signature: String,
    pub body: String,
}

pub fn extract_symbols_from_source(path: &Path, source: &str) -> Option<Vec<ParsedSymbolInfo>> {
    let lang_provider = detect_language(path)?;
    let tree = parse_source(source, (lang_provider.grammar)()).ok()?;
    let symbols = find_symbols_in_tree(&tree, source, &lang_provider.symbol_node_types);

    let mut result = Vec::new();
    for (node, kind, name, parent_scope) in symbols {
        let sig = extract_signature(node, source);
        let body_node = find_child_by_kind(node, "block")
            .or_else(|| find_child_by_kind(node, "statement_block"))
            .or_else(|| find_child_by_kind(node, "class_body"))
            .or_else(|| find_child_by_kind(node, "interface_body"))
            .or_else(|| find_child_by_kind(node, "enum_body"))
            .or_else(|| find_child_by_kind(node, "function_body"))
            .or_else(|| find_child_by_kind(node, "field_declaration_list"))
            .or_else(|| find_child_by_kind(node, "declaration_list"));
        let body_text = body_node.map(|b| node_text(b, source)).unwrap_or_default();
        result.push(ParsedSymbolInfo {
            key: StructuralSymbolKey {
                parent_scope,
                kind: kind.clone(),
                name: name.clone(),
            },
            name,
            kind,
            signature: sig,
            body: body_text,
        });
    }
    Some(result)
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Classify repository changes deterministically from Git deltas and semantic AST evidence.
pub fn classify_changes(
    repo_root: &Path,
    base_ref: Option<&str>,
    head_ref: Option<&str>,
) -> Result<ChangeSet, ClassifyError> {
    let raw_changes = collect_git_deltas(repo_root, base_ref, head_ref)?;
    let base_name = base_ref.unwrap_or("HEAD");

    let mut semantic_changes = Vec::new();
    let mut uncertainties = Vec::new();
    let mut overall_assurance = AssuranceLevel::Exact;

    for raw in raw_changes {
        let file_path = &raw.path;
        let abs_path = repo_root.join(file_path);

        match raw.kind {
            ChangeKind::Added => {
                let after_content = if let Some(head) = head_ref {
                    read_git_file_content(repo_root, head, file_path)
                } else if abs_path.is_file() {
                    std::fs::read_to_string(&abs_path).ok()
                } else {
                    None
                };

                let after_digest = after_content.as_ref().map(|c| sha256_hex(c.as_bytes()));
                let change_id = compute_change_id(
                    file_path,
                    None,
                    SemanticChangeKind::FileAdded,
                    None,
                    after_digest.as_deref(),
                );

                let ev = vec![EvidenceRef {
                    provider: EvidenceProviderKind::TreeSitter,
                    provider_fingerprint: "ts-native".to_string(),
                    strength: EvidenceStrength::Structural,
                    source_identity: file_path.clone(),
                    source_hash: after_digest.clone(),
                    freshness: FreshnessMetadata::default(),
                }];
                let change_assurance = assurance_ceiling_for_evidence(&ev);
                overall_assurance = combine_assurance(overall_assurance, change_assurance);

                semantic_changes.push(SemanticChange {
                    id: change_id,
                    file: file_path.clone(),
                    symbol: None,
                    change_kind: SemanticChangeKind::FileAdded,
                    before: None,
                    after: Some(ChangeSubject {
                        path: file_path.clone(),
                        symbol: None,
                        signature: None,
                        digest: after_digest.clone(),
                    }),
                    evidence: ev,
                    assurance: change_assurance,
                    reasons: vec!["file_added".to_string()],
                });

                // Extract symbols added
                if let Some(ref content) = after_content {
                    if let Some(symbols) =
                        extract_symbols_from_source(Path::new(file_path), content)
                    {
                        for sym in symbols {
                            let sym_digest = sha256_hex(sym.body.as_bytes());
                            let sym_id = compute_change_id(
                                file_path,
                                Some(&sym.name),
                                SemanticChangeKind::SymbolAdded,
                                None,
                                Some(&sym_digest),
                            );
                            let sym_ev = vec![EvidenceRef {
                                provider: EvidenceProviderKind::TreeSitter,
                                provider_fingerprint: "ts-native".to_string(),
                                strength: EvidenceStrength::Structural,
                                source_identity: file_path.clone(),
                                source_hash: after_digest.clone(),
                                freshness: FreshnessMetadata::default(),
                            }];
                            let sym_assurance = assurance_ceiling_for_evidence(&sym_ev);
                            overall_assurance = combine_assurance(overall_assurance, sym_assurance);

                            semantic_changes.push(SemanticChange {
                                id: sym_id,
                                file: file_path.clone(),
                                symbol: Some(sym.name.clone()),
                                change_kind: SemanticChangeKind::SymbolAdded,
                                before: None,
                                after: Some(ChangeSubject {
                                    path: file_path.clone(),
                                    symbol: Some(sym.name),
                                    signature: Some(sym.signature),
                                    digest: Some(sym_digest),
                                }),
                                evidence: sym_ev,
                                assurance: sym_assurance,
                                reasons: vec!["symbol_added".to_string()],
                            });
                        }
                    }
                }
            }
            ChangeKind::Deleted => {
                let before_content = read_git_file_content(repo_root, base_name, file_path);
                let before_digest = before_content.as_ref().map(|c| sha256_hex(c.as_bytes()));
                let change_id = compute_change_id(
                    file_path,
                    None,
                    SemanticChangeKind::FileDeleted,
                    before_digest.as_deref(),
                    None,
                );

                let ev = vec![EvidenceRef {
                    provider: EvidenceProviderKind::TreeSitter,
                    provider_fingerprint: "ts-native".to_string(),
                    strength: EvidenceStrength::Structural,
                    source_identity: file_path.clone(),
                    source_hash: before_digest.clone(),
                    freshness: FreshnessMetadata::default(),
                }];
                let change_assurance = assurance_ceiling_for_evidence(&ev);
                overall_assurance = combine_assurance(overall_assurance, change_assurance);

                semantic_changes.push(SemanticChange {
                    id: change_id,
                    file: file_path.clone(),
                    symbol: None,
                    change_kind: SemanticChangeKind::FileDeleted,
                    before: Some(ChangeSubject {
                        path: file_path.clone(),
                        symbol: None,
                        signature: None,
                        digest: before_digest.clone(),
                    }),
                    after: None,
                    evidence: ev,
                    assurance: change_assurance,
                    reasons: vec!["file_deleted".to_string()],
                });

                // Extract deleted symbols from before content
                if let Some(ref content) = before_content {
                    if let Some(symbols) =
                        extract_symbols_from_source(Path::new(file_path), content)
                    {
                        for sym in symbols {
                            let sym_digest = sha256_hex(sym.body.as_bytes());
                            let sym_id = compute_change_id(
                                file_path,
                                Some(&sym.name),
                                SemanticChangeKind::SymbolDeleted,
                                Some(&sym_digest),
                                None,
                            );
                            let sym_ev = vec![EvidenceRef {
                                provider: EvidenceProviderKind::TreeSitter,
                                provider_fingerprint: "ts-native".to_string(),
                                strength: EvidenceStrength::Structural,
                                source_identity: file_path.clone(),
                                source_hash: before_digest.clone(),
                                freshness: FreshnessMetadata::default(),
                            }];
                            let sym_assurance = assurance_ceiling_for_evidence(&sym_ev);
                            overall_assurance = combine_assurance(overall_assurance, sym_assurance);

                            semantic_changes.push(SemanticChange {
                                id: sym_id,
                                file: file_path.clone(),
                                symbol: Some(sym.name.clone()),
                                change_kind: SemanticChangeKind::SymbolDeleted,
                                before: Some(ChangeSubject {
                                    path: file_path.clone(),
                                    symbol: Some(sym.name),
                                    signature: Some(sym.signature),
                                    digest: Some(sym_digest),
                                }),
                                after: None,
                                evidence: sym_ev,
                                assurance: sym_assurance,
                                reasons: vec!["symbol_deleted".to_string()],
                            });
                        }
                    }
                }
            }
            ChangeKind::Renamed => {
                let old_p = raw.old_path.as_deref().unwrap_or(file_path);
                let before_content = read_git_file_content(repo_root, base_name, old_p);
                let after_content = if let Some(head) = head_ref {
                    read_git_file_content(repo_root, head, file_path)
                } else if abs_path.is_file() {
                    std::fs::read_to_string(&abs_path).ok()
                } else {
                    None
                };

                let before_digest = before_content.as_ref().map(|c| sha256_hex(c.as_bytes()));
                let after_digest = after_content.as_ref().map(|c| sha256_hex(c.as_bytes()));
                let change_id = compute_change_id(
                    file_path,
                    None,
                    SemanticChangeKind::FileRenamed,
                    before_digest.as_deref(),
                    after_digest.as_deref(),
                );

                let ev = vec![EvidenceRef {
                    provider: EvidenceProviderKind::TreeSitter,
                    provider_fingerprint: "ts-native".to_string(),
                    strength: EvidenceStrength::Structural,
                    source_identity: file_path.clone(),
                    source_hash: None,
                    freshness: FreshnessMetadata::default(),
                }];
                let change_assurance = assurance_ceiling_for_evidence(&ev);
                overall_assurance = combine_assurance(overall_assurance, change_assurance);

                semantic_changes.push(SemanticChange {
                    id: change_id,
                    file: file_path.clone(),
                    symbol: None,
                    change_kind: SemanticChangeKind::FileRenamed,
                    before: Some(ChangeSubject {
                        path: old_p.to_string(),
                        symbol: None,
                        signature: None,
                        digest: before_digest,
                    }),
                    after: Some(ChangeSubject {
                        path: file_path.clone(),
                        symbol: None,
                        signature: None,
                        digest: after_digest,
                    }),
                    evidence: ev,
                    assurance: change_assurance,
                    reasons: vec![format!("file_renamed_from:{}", old_p)],
                });
            }
            ChangeKind::Modified => {
                let before_content = read_git_file_content(repo_root, base_name, file_path);
                let after_content = if let Some(head) = head_ref {
                    read_git_file_content(repo_root, head, file_path)
                } else if abs_path.is_file() {
                    std::fs::read_to_string(&abs_path).ok()
                } else {
                    None
                };

                let before_digest = before_content.as_ref().map(|c| sha256_hex(c.as_bytes()));
                let after_digest = after_content.as_ref().map(|c| sha256_hex(c.as_bytes()));

                let before_symbols_opt = before_content
                    .as_ref()
                    .and_then(|c| extract_symbols_from_source(Path::new(file_path), c));
                let after_symbols_opt = after_content
                    .as_ref()
                    .and_then(|c| extract_symbols_from_source(Path::new(file_path), c));

                match (before_symbols_opt, after_symbols_opt) {
                    (Some(before_syms), Some(after_syms)) => {
                        let mut before_map: HashMap<StructuralSymbolKey, ParsedSymbolInfo> =
                            HashMap::new();
                        let mut before_duplicates: HashSet<StructuralSymbolKey> = HashSet::new();
                        for sym in before_syms {
                            if before_map.insert(sym.key.clone(), sym.clone()).is_some() {
                                before_duplicates.insert(sym.key);
                            }
                        }

                        let mut after_map: HashMap<StructuralSymbolKey, ParsedSymbolInfo> =
                            HashMap::new();
                        let mut after_duplicates: HashSet<StructuralSymbolKey> = HashSet::new();
                        for sym in after_syms {
                            if after_map.insert(sym.key.clone(), sym.clone()).is_some() {
                                after_duplicates.insert(sym.key);
                            }
                        }

                        for dup in before_duplicates.union(&after_duplicates) {
                            uncertainties.push(UncertaintyReason::AmbiguousSymbol(format!(
                                "Duplicate symbol declaration for {:?} in {}",
                                dup.name, file_path
                            )));
                        }

                        let mut seen_keys = HashSet::new();

                        // Check modifications and additions
                        for (key, after_sym) in &after_map {
                            seen_keys.insert(key.clone());
                            let name = &after_sym.name;
                            if let Some(before_sym) = before_map.get(key) {
                                let sig_before_norm = normalize_ws(&before_sym.signature);
                                let sig_after_norm = normalize_ws(&after_sym.signature);
                                let body_before_norm = normalize_ws(&before_sym.body);
                                let body_after_norm = normalize_ws(&after_sym.body);

                                if sig_before_norm != sig_after_norm {
                                    let b_digest = sha256_hex(before_sym.signature.as_bytes());
                                    let a_digest = sha256_hex(after_sym.signature.as_bytes());
                                    let cid = compute_change_id(
                                        file_path,
                                        Some(name),
                                        SemanticChangeKind::SignatureChanged,
                                        Some(&b_digest),
                                        Some(&a_digest),
                                    );
                                    let ev = vec![EvidenceRef {
                                        provider: EvidenceProviderKind::TreeSitter,
                                        provider_fingerprint: "ts-native".to_string(),
                                        strength: EvidenceStrength::Structural,
                                        source_identity: file_path.clone(),
                                        source_hash: after_digest.clone(),
                                        freshness: FreshnessMetadata::default(),
                                    }];
                                    let change_assurance = assurance_ceiling_for_evidence(&ev);
                                    overall_assurance =
                                        combine_assurance(overall_assurance, change_assurance);

                                    semantic_changes.push(SemanticChange {
                                        id: cid,
                                        file: file_path.clone(),
                                        symbol: Some(name.clone()),
                                        change_kind: SemanticChangeKind::SignatureChanged,
                                        before: Some(ChangeSubject {
                                            path: file_path.clone(),
                                            symbol: Some(name.clone()),
                                            signature: Some(before_sym.signature.clone()),
                                            digest: Some(b_digest),
                                        }),
                                        after: Some(ChangeSubject {
                                            path: file_path.clone(),
                                            symbol: Some(name.clone()),
                                            signature: Some(after_sym.signature.clone()),
                                            digest: Some(a_digest),
                                        }),
                                        evidence: ev,
                                        assurance: change_assurance,
                                        reasons: vec!["signature_changed".to_string()],
                                    });
                                } else if body_before_norm != body_after_norm {
                                    let b_digest = sha256_hex(before_sym.body.as_bytes());
                                    let a_digest = sha256_hex(after_sym.body.as_bytes());
                                    let cid = compute_change_id(
                                        file_path,
                                        Some(name),
                                        SemanticChangeKind::ImplementationChanged,
                                        Some(&b_digest),
                                        Some(&a_digest),
                                    );
                                    let ev = vec![EvidenceRef {
                                        provider: EvidenceProviderKind::TreeSitter,
                                        provider_fingerprint: "ts-native".to_string(),
                                        strength: EvidenceStrength::Structural,
                                        source_identity: file_path.clone(),
                                        source_hash: after_digest.clone(),
                                        freshness: FreshnessMetadata::default(),
                                    }];
                                    let change_assurance = assurance_ceiling_for_evidence(&ev);
                                    overall_assurance =
                                        combine_assurance(overall_assurance, change_assurance);

                                    semantic_changes.push(SemanticChange {
                                        id: cid,
                                        file: file_path.clone(),
                                        symbol: Some(name.clone()),
                                        change_kind: SemanticChangeKind::ImplementationChanged,
                                        before: Some(ChangeSubject {
                                            path: file_path.clone(),
                                            symbol: Some(name.clone()),
                                            signature: Some(before_sym.signature.clone()),
                                            digest: Some(b_digest),
                                        }),
                                        after: Some(ChangeSubject {
                                            path: file_path.clone(),
                                            symbol: Some(name.clone()),
                                            signature: Some(after_sym.signature.clone()),
                                            digest: Some(a_digest),
                                        }),
                                        evidence: ev,
                                        assurance: change_assurance,
                                        reasons: vec!["implementation_changed".to_string()],
                                    });
                                }
                            } else {
                                // Symbol added
                                let a_digest = sha256_hex(after_sym.body.as_bytes());
                                let cid = compute_change_id(
                                    file_path,
                                    Some(name),
                                    SemanticChangeKind::SymbolAdded,
                                    None,
                                    Some(&a_digest),
                                );
                                let ev = vec![EvidenceRef {
                                    provider: EvidenceProviderKind::TreeSitter,
                                    provider_fingerprint: "ts-native".to_string(),
                                    strength: EvidenceStrength::Structural,
                                    source_identity: file_path.clone(),
                                    source_hash: after_digest.clone(),
                                    freshness: FreshnessMetadata::default(),
                                }];
                                let change_assurance = assurance_ceiling_for_evidence(&ev);
                                overall_assurance =
                                    combine_assurance(overall_assurance, change_assurance);

                                semantic_changes.push(SemanticChange {
                                    id: cid,
                                    file: file_path.clone(),
                                    symbol: Some(name.clone()),
                                    change_kind: SemanticChangeKind::SymbolAdded,
                                    before: None,
                                    after: Some(ChangeSubject {
                                        path: file_path.clone(),
                                        symbol: Some(name.clone()),
                                        signature: Some(after_sym.signature.clone()),
                                        digest: Some(a_digest),
                                    }),
                                    evidence: ev,
                                    assurance: change_assurance,
                                    reasons: vec!["symbol_added".to_string()],
                                });
                            }
                        }

                        // Check deletions
                        for (key, before_sym) in &before_map {
                            if !seen_keys.contains(key) {
                                let name = &before_sym.name;
                                let b_digest = sha256_hex(before_sym.body.as_bytes());
                                let cid = compute_change_id(
                                    file_path,
                                    Some(name),
                                    SemanticChangeKind::SymbolDeleted,
                                    Some(&b_digest),
                                    None,
                                );
                                let ev = vec![EvidenceRef {
                                    provider: EvidenceProviderKind::TreeSitter,
                                    provider_fingerprint: "ts-native".to_string(),
                                    strength: EvidenceStrength::Structural,
                                    source_identity: file_path.clone(),
                                    source_hash: before_digest.clone(),
                                    freshness: FreshnessMetadata::default(),
                                }];
                                let change_assurance = assurance_ceiling_for_evidence(&ev);
                                overall_assurance =
                                    combine_assurance(overall_assurance, change_assurance);

                                semantic_changes.push(SemanticChange {
                                    id: cid,
                                    file: file_path.clone(),
                                    symbol: Some(name.clone()),
                                    change_kind: SemanticChangeKind::SymbolDeleted,
                                    before: Some(ChangeSubject {
                                        path: file_path.clone(),
                                        symbol: Some(name.clone()),
                                        signature: Some(before_sym.signature.clone()),
                                        digest: Some(b_digest),
                                    }),
                                    after: None,
                                    evidence: ev,
                                    assurance: change_assurance,
                                    reasons: vec!["symbol_deleted".to_string()],
                                });
                            }
                        }

                        // If no specific symbol changes found (e.g. top-level edits / comments)
                        if semantic_changes.iter().all(|c| c.file != *file_path) {
                            let cid = compute_change_id(
                                file_path,
                                None,
                                SemanticChangeKind::SymbolChanged,
                                before_digest.as_deref(),
                                after_digest.as_deref(),
                            );
                            let ev = vec![EvidenceRef {
                                provider: EvidenceProviderKind::TreeSitter,
                                provider_fingerprint: "ts-native".to_string(),
                                strength: EvidenceStrength::Structural,
                                source_identity: file_path.clone(),
                                source_hash: after_digest.clone(),
                                freshness: FreshnessMetadata::default(),
                            }];
                            let change_assurance = assurance_ceiling_for_evidence(&ev);
                            overall_assurance =
                                combine_assurance(overall_assurance, change_assurance);

                            semantic_changes.push(SemanticChange {
                                id: cid,
                                file: file_path.clone(),
                                symbol: None,
                                change_kind: SemanticChangeKind::SymbolChanged,
                                before: Some(ChangeSubject {
                                    path: file_path.clone(),
                                    symbol: None,
                                    signature: None,
                                    digest: before_digest.clone(),
                                }),
                                after: Some(ChangeSubject {
                                    path: file_path.clone(),
                                    symbol: None,
                                    signature: None,
                                    digest: after_digest.clone(),
                                }),
                                evidence: ev,
                                assurance: change_assurance,
                                reasons: vec!["top_level_or_structural_change".to_string()],
                            });
                        }
                    }
                    _ => {
                        // Unsupported language or failed parse -> Unknown
                        let cid = compute_change_id(
                            file_path,
                            None,
                            SemanticChangeKind::Unknown,
                            before_digest.as_deref(),
                            after_digest.as_deref(),
                        );
                        let reason = UncertaintyReason::UnsupportedLanguage(format!(
                            "Language parser unavailable for {}",
                            file_path
                        ));
                        uncertainties.push(reason);

                        let ev = vec![EvidenceRef {
                            provider: EvidenceProviderKind::ManualRule,
                            provider_fingerprint: "file-delta".to_string(),
                            strength: EvidenceStrength::Heuristic,
                            source_identity: file_path.clone(),
                            source_hash: None,
                            freshness: FreshnessMetadata::default(),
                        }];
                        let change_assurance = assurance_ceiling_for_evidence(&ev);
                        overall_assurance = combine_assurance(overall_assurance, change_assurance);

                        semantic_changes.push(SemanticChange {
                            id: cid,
                            file: file_path.clone(),
                            symbol: None,
                            change_kind: SemanticChangeKind::Unknown,
                            before: Some(ChangeSubject {
                                path: file_path.clone(),
                                symbol: None,
                                signature: None,
                                digest: before_digest,
                            }),
                            after: Some(ChangeSubject {
                                path: file_path.clone(),
                                symbol: None,
                                signature: None,
                                digest: after_digest,
                            }),
                            evidence: ev,
                            assurance: change_assurance,
                            reasons: vec!["unsupported_language_or_non_code".to_string()],
                        });
                    }
                }
            }
        }
    }

    // Sort semantic changes deterministically by (file, symbol, change_kind, id)
    semantic_changes.sort_by(|a, b| {
        a.file
            .cmp(&b.file)
            .then_with(|| a.symbol.cmp(&b.symbol))
            .then_with(|| format!("{:?}", a.change_kind).cmp(&format!("{:?}", b.change_kind)))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(ChangeSet {
        base_ref: base_ref.map(|s| s.to_string()),
        head_ref: head_ref.map(|s| s.to_string()),
        changes: semantic_changes,
        assurance: overall_assurance,
        uncertainty: uncertainties,
    })
}
