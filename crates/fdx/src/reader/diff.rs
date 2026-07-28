use crate::reader::code::{
    cache::AstCache, languages::detect_language, parser::parse_source, prototype::PrototypeReader,
};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Options controlling diff generation.
#[derive(Debug, Clone)]
pub struct DiffOptions {
    pub commit: String,
    pub staged: bool,
    pub paths: Vec<PathBuf>,
    pub no_cache: bool,
    pub root: PathBuf,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            commit: "HEAD~1".to_string(),
            staged: false,
            paths: Vec::new(),
            no_cache: false,
            root: PathBuf::from("."),
        }
    }
}

/// Change classification for a symbol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeType {
    SignatureChanged,
    BodyChanged,
    Added,
    Deleted,
    FileLevel,
}

impl std::fmt::Display for ChangeType {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            ChangeType::SignatureChanged => write!(f, "signature_changed"),
            ChangeType::BodyChanged => write!(f, "body_changed"),
            ChangeType::Added => write!(f, "added"),
            ChangeType::Deleted => write!(f, "deleted"),
            ChangeType::FileLevel => write!(f, "file_level"),
        }
    }
}

/// A single symbol-level change.
#[derive(Debug, Clone)]
pub struct SymbolChange {
    pub kind: String,
    pub name: String,
    pub change_type: ChangeType,
    pub line_start: usize,
    pub line_end: usize,
    pub lines_added: usize,
    pub lines_removed: usize,
}

/// A file-level change (imports, top-level statements, etc.).
#[derive(Debug, Clone)]
pub struct FileLevelChange {
    pub line_start: usize,
    pub line_end: usize,
    pub lines_added: usize,
    pub lines_removed: usize,
    pub raw_lines: Vec<String>,
}

/// Diff result for a single file.
#[derive(Debug, Clone)]
pub struct DiffFileResult {
    pub path: String,
    pub status: FileStatus,
    pub language: Option<String>,
    pub symbol_changes: Vec<SymbolChange>,
    pub file_level_changes: Vec<FileLevelChange>,
    pub lines_added: usize,
    pub lines_removed: usize,
}

/// File change status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
}

impl std::fmt::Display for FileStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            FileStatus::Modified => write!(f, "modified"),
            FileStatus::Added => write!(f, "added"),
            FileStatus::Deleted => write!(f, "deleted"),
        }
    }
}

/// Generate a symbol-aware diff against a git ref.
pub fn diff_against(
    options: &DiffOptions,
    cache: &AstCache,
) -> anyhow::Result<Vec<DiffFileResult>> {
    // Verify git is available and we're in a repo
    let git_check = Command::new("git")
        .arg("rev-parse")
        .arg("--git-dir")
        .current_dir(&options.root)
        .output()?;

    if !git_check.status.success() {
        anyhow::bail!("error: not a git repository (or git not found)");
    }

    // Build git diff command
    let mut cmd = Command::new("git");
    cmd.arg("diff")
        .arg("--unified=3")
        .current_dir(&options.root);

    if options.staged {
        cmd.arg("--cached");
    } else {
        cmd.arg(&options.commit);
    }

    if !options.paths.is_empty() {
        cmd.arg("--");
        for path in &options.paths {
            cmd.arg(path);
        }
    }

    let output = cmd.output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git diff failed (invalid base ref): {}", stderr);
    }

    let diff_text = String::from_utf8_lossy(&output.stdout);

    if diff_text.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Parse unified diff
    let mut patch = unidiff::PatchSet::new();
    patch
        .parse(&diff_text)
        .map_err(|e| anyhow::anyhow!("Failed to parse diff: {}", e))?;

    let mut results = Vec::new();

    for patched_file in patch.files() {
        let path = patched_file.path();
        let status = if patched_file.is_added_file() {
            FileStatus::Added
        } else if patched_file.is_removed_file() {
            FileStatus::Deleted
        } else {
            FileStatus::Modified
        };

        let lines_added = patched_file.added();
        let lines_removed = patched_file.removed();

        // For deleted files, we can't parse the current version
        if status == FileStatus::Deleted {
            results.push(DiffFileResult {
                path,
                status,
                language: None,
                symbol_changes: Vec::new(),
                file_level_changes: Vec::new(),
                lines_added,
                lines_removed,
            });
            continue;
        }

        // For added/modified files, try to parse current version
        let file_path = options.root.join(&path);
        let provider = detect_language(&file_path);

        let (symbol_changes, file_level_changes) = if let Some(ref prov) = provider {
            match analyze_file_changes(
                &file_path,
                patched_file,
                prov,
                cache,
                options.no_cache,
                &options.commit,
                &options.root,
            ) {
                Ok((sc, flc)) => (sc, flc),
                Err(_) => {
                    // Parse error — report as plain file change
                    (Vec::new(), Vec::new())
                }
            }
        } else {
            // Non-code file — no symbol resolution

            (Vec::new(), Vec::new())
        };

        results.push(DiffFileResult {
            path,
            status,
            language: provider.map(|p| p.name.to_string()),
            symbol_changes,
            file_level_changes,
            lines_added,
            lines_removed,
        });
    }

    Ok(results)
}

/// Analyze changes for a single file, resolving to symbols via dual-AST parsing.
fn analyze_file_changes(
    file_path: &Path,
    patched_file: &unidiff::PatchedFile,
    provider: &crate::reader::code::languages::LanguageProvider,
    cache: &AstCache,
    no_cache: bool,
    commit: &str,
    root: &Path,
) -> anyhow::Result<(Vec<SymbolChange>, Vec<FileLevelChange>)> {
    let source = std::fs::read_to_string(file_path)?;

    let tree = if no_cache {
        parse_source(&source, (provider.grammar)())?
    } else {
        let metadata = std::fs::metadata(file_path)?;
        let mtime = metadata.modified()?;
        let path_buf = file_path.to_path_buf();

        if let Some(cached_tree) = cache.get(&path_buf, mtime) {
            cached_tree
        } else {
            let tree = parse_source(&source, (provider.grammar)())?;
            cache.insert(path_buf, mtime, tree.clone());
            tree
        }
    };

    let reader = PrototypeReader::new();
    let target_symbols = reader.extract_prototypes(file_path, &source, &tree)?;

    // Attempt to fetch base ref source via git show
    let rel_path = file_path.strip_prefix(root).unwrap_or(file_path);
    let git_show = Command::new("git")
        .arg("show")
        .arg(format!(
            "{}:{}",
            commit,
            rel_path.to_string_lossy().replace('\\', "/")
        ))
        .current_dir(root)
        .output();

    let base_source = match git_show {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => String::new(),
    };

    let base_symbols = if !base_source.is_empty() {
        if let Ok(base_tree) = parse_source(&base_source, (provider.grammar)()) {
            reader
                .extract_prototypes(file_path, &base_source, &base_tree)
                .unwrap_or_default()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    // Separate added and removed lines

    let mut added_lines = Vec::new();
    let mut removed_lines = Vec::new();

    for hunk in patched_file.hunks() {
        for line in hunk.lines() {
            if line.is_added() {
                if let Some(target_line) = line.target_line_no {
                    added_lines.push(target_line);
                }
            } else if line.is_removed() {
                if let Some(source_line) = line.source_line_no {
                    removed_lines.push(source_line);
                }
            }
        }
    }

    // Map changed lines using qualified scoped identity (parent_scope/kind:name)
    struct SymbolChangeEntry {
        change_type: ChangeType,
        kind: String,
        name: String,
        line_start: usize,
        line_end: usize,
        lines_added: usize,
        lines_removed: usize,
    }

    let mut symbol_change_map: std::collections::HashMap<String, SymbolChangeEntry> =
        std::collections::HashMap::new();
    let mut file_level_raw: Vec<(usize, String, ChangeType)> = Vec::new();

    // Process added lines against target_symbols

    for line_no in added_lines {
        let mut matched = false;
        for sym in &target_symbols {
            if line_no >= sym.line_start && line_no <= sym.line_end {
                matched = true;
                let key = sym.scoped_identity();
                let is_sig = line_no == sym.line_start;
                let is_new_sym = !base_symbols.iter().any(|b| b.scoped_identity() == key);

                let change_type = if is_new_sym {
                    ChangeType::Added
                } else if is_sig {
                    ChangeType::SignatureChanged
                } else {
                    ChangeType::BodyChanged
                };

                let entry = symbol_change_map.entry(key).or_insert_with(|| SymbolChangeEntry {
                    change_type,
                    kind: sym.kind.clone(),
                    name: sym.name.clone(),
                    line_start: sym.line_start,
                    line_end: sym.line_end,
                    lines_added: 0,
                    lines_removed: 0,
                });
                entry.lines_added += 1;
                break;
            }
        }
        if !matched {
            let raw = format!(
                "+ {}",
                source.lines().nth(line_no.saturating_sub(1)).unwrap_or("")
            );
            file_level_raw.push((line_no, raw, ChangeType::Added));
        }
    }

    // Process removed lines against base_symbols

    for line_no in removed_lines {
        let mut matched = false;
        for sym in &base_symbols {
            if line_no >= sym.line_start && line_no <= sym.line_end {
                matched = true;
                let key = sym.scoped_identity();
                let is_deleted_sym = !target_symbols.iter().any(|t| t.scoped_identity() == key);
                let change_type = if is_deleted_sym {
                    ChangeType::Deleted
                } else {
                    ChangeType::BodyChanged
                };

                let entry = symbol_change_map.entry(key).or_insert_with(|| SymbolChangeEntry {
                    change_type,
                    kind: sym.kind.clone(),
                    name: sym.name.clone(),
                    line_start: sym.line_start,
                    line_end: sym.line_end,
                    lines_added: 0,
                    lines_removed: 0,
                });
                entry.lines_removed += 1;
                break;
            }
        }
        if !matched {
            let raw = format!(
                "- {}",
                base_source
                    .lines()
                    .nth(line_no.saturating_sub(1))
                    .unwrap_or("")
            );
            file_level_raw.push((line_no, raw, ChangeType::Deleted));
        }
    }

    let mut symbol_changes: Vec<SymbolChange> = Vec::new();

    for (_, entry) in symbol_change_map {
        symbol_changes.push(SymbolChange {
            kind: entry.kind,
            name: entry.name,
            change_type: entry.change_type,
            line_start: entry.line_start,
            line_end: entry.line_end,
            lines_added: entry.lines_added,
            lines_removed: entry.lines_removed,
        });
    }

    symbol_changes.sort_by_key(|sc| sc.line_start);

    // Build file-level changes — group contiguous lines

    let mut file_level_changes = Vec::new();
    if !file_level_raw.is_empty() {
        file_level_raw.sort_by_key(|(line, _, _)| *line);

        let mut current_start = file_level_raw[0].0;
        let mut current_end = file_level_raw[0].0;
        let mut current_raw: Vec<String> = vec![file_level_raw[0].1.clone()];
        let mut current_added = if file_level_raw[0].2 == ChangeType::Added {
            1
        } else {
            0
        };
        let mut current_removed = if file_level_raw[0].2 == ChangeType::Deleted {
            1
        } else {
            0
        };

        for item in file_level_raw.iter().skip(1) {
            let (line_no, raw, change_type) = item;

            if *line_no <= current_end + 1 {
                // Contiguous
                current_end = *line_no;
                current_raw.push(raw.clone());
                if *change_type == ChangeType::Added {
                    current_added += 1;
                } else {
                    current_removed += 1;
                }
            } else {
                // New group
                file_level_changes.push(FileLevelChange {
                    line_start: current_start,
                    line_end: current_end,
                    lines_added: current_added,
                    lines_removed: current_removed,
                    raw_lines: current_raw,
                });
                current_start = *line_no;
                current_end = *line_no;
                current_raw = vec![raw.clone()];
                current_added = if *change_type == ChangeType::Added {
                    1
                } else {
                    0
                };
                current_removed = if *change_type == ChangeType::Deleted {
                    1
                } else {
                    0
                };
            }
        }

        file_level_changes.push(FileLevelChange {
            line_start: current_start,
            line_end: current_end,
            lines_added: current_added,
            lines_removed: current_removed,
            raw_lines: current_raw,
        });
    }

    Ok((symbol_changes, file_level_changes))
}
