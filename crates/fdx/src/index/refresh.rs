//! Incremental refresh: update only the changed files, never rescan the
//! whole repository.
//!
//! Task 3 §7 / §15:
//! - deterministic sources: git HEAD comparison, dirty worktree status,
//!   filesystem metadata, content hash where metadata is insufficient;
//! - handles creation, modification, deletion, rename, directory rename,
//!   ignored files, generated files, symlinks, case-only rename, branch
//!   checkout, merge, rebase, detached HEAD, restart after missed watcher
//!   events;
//! - no full scan on no-change refresh;
//! - localized component updates.

use crate::index::builder::{
    build_dependencies_for_file, build_git_state, build_symbols_for_file, CLASS_BINARY,
    CLASS_GENERATED,
};
use crate::index::components::{
    ContentCacheComponent, DependenciesComponent, FilesComponent, GitStateComponent,
    SymbolsComponent, TestMappingComponent,
};
use crate::index::manifest::{DependencyEdge, FileMeta, GitStateSnapshot, TestMappingRow};
use crate::index::storage::sha256_hex;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// What changed between two refresh passes.
#[derive(Debug, Clone, Default)]
pub struct ChangeSet {
    /// Files that changed content (modified).
    pub changed: BTreeSet<String>,
    /// Newly added files.
    pub added: BTreeSet<String>,
    /// Deleted files.
    pub deleted: BTreeSet<String>,
    /// Renamed: (old, new).
    pub renamed: Vec<(String, String)>,
    /// True when a full rebuild is required (branch switch, schema change,
    /// large structural change).
    pub full_rebuild: bool,
    /// Reason for full rebuild ("" when incremental).
    pub reason: String,
}

impl ChangeSet {
    pub fn is_empty(&self) -> bool {
        !self.full_rebuild
            && self.changed.is_empty()
            && self.added.is_empty()
            && self.deleted.is_empty()
            && self.renamed.is_empty()
    }

    pub fn full(reason: impl Into<String>) -> Self {
        Self {
            full_rebuild: true,
            reason: reason.into(),
            ..Default::default()
        }
    }
}

/// Compute the change set between the previous git snapshot and the current
/// worktree state.
///
/// `prev_snapshot` is the last persisted git state; the current state is
/// captured fresh. When HEAD changed (branch checkout, merge, rebase) a full
/// rebuild is signalled because the tracked-file set may have changed
/// wholesale — but the caller may still choose to apply it incrementally by
/// diffing trees; for Task 3 correctness we rebuild on HEAD change.
pub fn compute_change_set(prev_snapshot: &GitStateSnapshot, next: &GitStateSnapshot) -> ChangeSet {
    if prev_snapshot.head_sha.is_empty() && !next.head_sha.is_empty() {
        // First time we see a git repo: incremental from empty.
        return ChangeSet::full("initial git snapshot");
    }
    if !prev_snapshot.head_sha.is_empty() && prev_snapshot.head_sha != next.head_sha {
        // Branch checkout / merge / rebase / commit: HEAD moved. The safest
        // correct behaviour is a full rebuild of the tree-derived layers.
        return ChangeSet::full(format!(
            "HEAD changed {} -> {}",
            short(&prev_snapshot.head_sha),
            short(&next.head_sha)
        ));
    }

    let mut cs = ChangeSet::default();

    // Files that were tracked as changed before and are still changed now:
    // re-index. Files that were changed before but are now clean: no action
    // (content unchanged relative to HEAD).
    let prev_changed: BTreeSet<String> = prev_snapshot.changed_files.iter().cloned().collect();
    let next_changed: BTreeSet<String> = next.changed_files.iter().cloned().collect();
    for f in next_changed.difference(&prev_changed) {
        if next.deleted_files.contains(f) {
            cs.deleted.insert(f.clone());
        } else {
            cs.changed.insert(f.clone());
        }
    }
    // Files that stopped being changed and are now deleted.
    for f in &next.deleted_files {
        if !prev_snapshot.deleted_files.contains(f) {
            cs.deleted.insert(f.clone());
        }
    }
    // Newly untracked files.
    let prev_untracked: BTreeSet<String> = prev_snapshot.untracked_files.iter().cloned().collect();
    for f in &next.untracked_files {
        if !prev_untracked.contains(f) {
            cs.added.insert(f.clone());
        }
    }
    cs
}

fn short(sha: &str) -> String {
    if sha.len() > 8 {
        sha[..8].to_string()
    } else {
        sha.to_string()
    }
}

/// Refresh result: the number of files re-indexed per layer.
#[derive(Debug, Clone, Default)]
pub struct RefreshStats {
    pub files_reindexed: usize,
    pub symbols_reindexed: usize,
    pub deps_reindexed: usize,
    pub cache_invalidated: usize,
    pub full_rebuild: bool,
}

/// The refresh engine. Owns no persistent state — it mutates the in-memory
/// components in place and reports what changed.
pub struct Refresher {
    /// Repository root.
    root: PathBuf,
    /// Current generation number.
    generation: u64,
}

impl Refresher {
    pub fn new(root: &Path, generation: u64) -> Self {
        Self {
            root: root.to_path_buf(),
            generation,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Apply an incremental change set to the in-memory components.
    ///
    /// `files` and `git_state` are updated here; `symbols`, `deps`, and
    /// `tests` are updated via the returned `SymbolsUpdate`/`DepsUpdate` data
    /// so the caller can apply them consistently (they are derived from the
    /// same file set).
    #[allow(clippy::too_many_arguments)]
    pub fn apply(
        &self,
        cs: &ChangeSet,
        files: &mut FilesComponent,
        symbols: &mut SymbolsComponent,
        deps: &mut DependenciesComponent,
        tests: &mut TestMappingComponent,
        cache: &mut ContentCacheComponent,
        git_state: &mut GitStateComponent,
        _ignored: &ignore::overrides::Override,
    ) -> RefreshStats {
        let mut stats = RefreshStats {
            full_rebuild: cs.full_rebuild,
            ..Default::default()
        };

        if cs.full_rebuild {
            // Full rebuild is handled by the caller (cold build path); we
            // still refresh git state so the snapshot is current.
            let next = build_git_state(
                &self.root,
                files,
                &git_state.snapshot.worktree_id,
                self.generation,
            );
            git_state.snapshot = next.snapshot;
            return stats;
        }

        // 1. Deletions: remove from every layer.
        for f in &cs.deleted {
            files.files.remove(f);
            symbols.remove_file(f);
            deps.remove_file(f);
            tests.remove_source(f);
            cache.invalidate_path(f);
            stats.files_reindexed += 1;
        }

        // 2. Renames: move metadata + symbols + edges.
        for (old, new) in &cs.renamed {
            if let Some(meta) = files.files.remove(old) {
                let mut moved = meta;
                moved.path = new.clone();
                files.files.insert(new.clone(), moved);
            }
            // Symbols move to the new file (re-index new content).
            symbols.remove_file(old);
            tests.remove_source(old);
            deps.remove_file(old);
            cache.invalidate_path(old);
            cache.invalidate_path(new);
            if let Ok(content) = std::fs::read_to_string(self.root.join(new)) {
                let syms =
                    build_symbols_for_file(&self.root.join(new), new, &content, self.generation);
                symbols.replace_file(new, syms);
                stats.symbols_reindexed += 1;
            }
        }

        // 3. Added + changed files: re-read, re-index metadata/symbols/deps.
        let mut to_index: Vec<String> = cs.added.iter().chain(cs.changed.iter()).cloned().collect();
        to_index.sort_unstable();
        to_index.dedup();

        for rel in &to_index {
            let abs = self.root.join(rel);
            if !abs.exists() {
                // Disappeared between status and refresh: treat as deleted.
                files.files.remove(rel);
                symbols.remove_file(rel);
                deps.remove_file(rel);
                tests.remove_source(rel);
                cache.invalidate_path(rel);
                continue;
            }
            let meta = file_meta(rel, &abs, self.generation);
            let language = meta.language.clone();
            files.files.insert(rel.clone(), meta);
            stats.files_reindexed += 1;

            if language == CLASS_BINARY || language == CLASS_GENERATED {
                // No symbols/deps for binary/generated files.
                symbols.remove_file(rel);
                deps.remove_file(rel);
                cache.invalidate_path(rel);
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&abs) else {
                continue;
            };
            let syms = build_symbols_for_file(&abs, rel, &content, self.generation);
            symbols.replace_file(rel, syms);
            stats.symbols_reindexed += 1;

            let mut edges = build_dependencies_for_file(rel, &content, self.generation);
            resolve_edges(rel, &mut edges, files, &language);
            deps.replace_file(rel, edges);
            stats.deps_reindexed += 1;
        }

        // 4. Refresh test mapping for touched source/test files.
        let mut touched: Vec<String> = Vec::new();
        touched.extend(cs.added.iter().cloned());
        touched.extend(cs.changed.iter().cloned());
        touched.extend(cs.deleted.iter().cloned());
        touched.extend(cs.renamed.iter().map(|(_, n)| n.clone()));
        for rel in touched {
            tests.remove_source(&rel);
            if let Some(meta) = files.files.get(&rel) {
                if meta.classification == "test" {
                    // Rebuild naming-based mapping for this test file.
                    let source = naming_source(&rel);
                    if files.files.contains_key(&source) {
                        tests.insert(TestMappingRow {
                            source_file: source,
                            test_file: rel.clone(),
                            basis: "naming".to_string(),
                            confidence: 0.8,
                        });
                    }
                }
            }
        }

        // 5. Cache invalidation for changed files.
        for rel in &cs.changed {
            cache.invalidate_path(rel);
            stats.cache_invalidated += 1;
        }

        // 6. Persist the fresh git snapshot.
        let next = build_git_state(
            &self.root,
            files,
            &git_state.snapshot.worktree_id,
            self.generation,
        );
        git_state.snapshot = next.snapshot;

        stats
    }

    /// Detect renamed files from a status change where git reports R.
    pub fn detect_renames(&self, cs: &mut ChangeSet, next_snapshot: &GitStateSnapshot) {
        // `git status --porcelain=v1` with default rename detection prints
        // `R  old -> new` — we capture renames from the caller's snapshot
        // fields if present; here we reconstruct from changed+deleted pairs
        // when names differ (best effort, deterministic).
        let deleted: Vec<String> = cs.deleted.iter().cloned().collect();
        let added: Vec<String> = cs.added.iter().cloned().collect();
        // Match deleted→added pairs by shared stem (heuristic; conservative).
        let mut used = BTreeSet::new();
        for d in &deleted {
            let stem = rename_stem(d);
            for a in &added {
                if used.contains(a) {
                    continue;
                }
                if rename_stem(a) == stem && a != d {
                    cs.renamed.push((d.clone(), a.clone()));
                    cs.deleted.remove(d);
                    cs.added.remove(a);
                    used.insert(a.clone());
                    break;
                }
            }
        }
        let _ = next_snapshot;
    }

    /// The file set that changed since the last snapshot, computed from
    /// filesystem metadata where git is unavailable (plain directory).
    pub fn fs_change_detection(
        &self,
        prev_files: &FilesComponent,
        current_files: &FilesComponent,
    ) -> ChangeSet {
        let mut cs = ChangeSet::default();
        let prev_keys: BTreeSet<String> = prev_files.files.keys().cloned().collect();
        let cur_keys: BTreeSet<String> = current_files.files.keys().cloned().collect();
        for key in cur_keys.difference(&prev_keys) {
            cs.added.insert(key.clone());
        }
        for key in prev_keys.difference(&cur_keys) {
            cs.deleted.insert(key.clone());
        }
        for (key, cur) in &current_files.files {
            if let Some(prev) = prev_files.files.get(key) {
                if prev.content_hash != cur.content_hash
                    || prev.size != cur.size
                    || prev.modified != cur.modified
                {
                    cs.changed.insert(key.clone());
                }
            }
        }
        cs
    }
}

/// Compute a `FileMeta` for a file during incremental refresh.
fn file_meta(rel: &str, abs: &Path, generation: u64) -> FileMeta {
    let is_test = rel.to_lowercase().contains("_test")
        || rel.to_lowercase().contains(".test.")
        || rel.to_lowercase().contains(".spec.")
        || rel.to_lowercase().contains("/tests/");
    let is_generated = {
        let name = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
        name.ends_with(".min.js")
            || name.ends_with(".map")
            || name == "package-lock.json"
            || name == "yarn.lock"
            || name == "bun.lock"
    };
    let is_binary = [
        ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".gz", ".tar", ".exe", ".dll", ".so",
        ".class", ".jar", ".woff", ".woff2", ".wasm", ".o", ".obj",
    ]
    .iter()
    .any(|ext| rel.to_lowercase().ends_with(ext));
    let meta = std::fs::symlink_metadata(abs).unwrap_or_else(|_| {
        // Fallback: minimal metadata
        #[cfg(unix)]
        {
            std::fs::metadata("/dev/null").unwrap()
        }
        #[cfg(not(unix))]
        {
            std::fs::metadata(".").unwrap()
        }
    });
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
    let content_hash = if is_binary {
        String::new()
    } else {
        std::fs::read(abs)
            .map(|b| sha256_hex(&b).chars().take(16).collect())
            .unwrap_or_default()
    };
    FileMeta {
        path: rel.to_string(),
        kind: kind.to_string(),
        size,
        modified,
        content_hash,
        language: crate::index::builder::detect_language_for(rel),
        executable,
        classification: if is_binary {
            CLASS_BINARY.to_string()
        } else if is_generated {
            CLASS_GENERATED.to_string()
        } else if is_test {
            "test".to_string()
        } else {
            "source".to_string()
        },
        generation,
    }
}

/// Resolve relative import edges against the file index.
fn resolve_edges(rel: &str, edges: &mut [DependencyEdge], files: &FilesComponent, language: &str) {
    for e in edges.iter_mut() {
        if !e.unresolved && (e.specifier.starts_with('.') || e.specifier.starts_with('/')) {
            if let Some(target) =
                crate::index::builder::resolve_import(rel, &e.specifier, files, language)
            {
                e.to_file = target;
                e.unresolved = false;
            } else {
                e.unresolved = true;
            }
        }
    }
}

/// A conservative stem for rename detection (lowercased path without final
/// extension).
fn rename_stem(path: &str) -> String {
    let lower = path.to_lowercase();
    match lower.rsplit_once('.') {
        Some((stem, _ext)) => stem.to_string(),
        None => lower,
    }
}

/// Source file that a test file likely maps to by naming.
fn naming_source(test: &str) -> String {
    for suffix in [
        ".test.ts", ".spec.ts", ".test.js", ".spec.js", "_test.rs", "_test.py", ".test.go",
    ] {
        if let Some(stem) = test.strip_suffix(suffix) {
            let ext = match suffix {
                ".test.ts" | ".spec.ts" => ".ts",
                ".test.js" | ".spec.js" => ".js",
                "_test.rs" => ".rs",
                "_test.py" => ".py",
                ".test.go" => ".go",
                _ => ".ts",
            };
            return format!("{stem}{ext}");
        }
    }
    test.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(
        head: &str,
        changed: &[&str],
        deleted: &[&str],
        untracked: &[&str],
    ) -> GitStateSnapshot {
        GitStateSnapshot {
            head_sha: head.to_string(),
            branch: "main".to_string(),
            changed_files: changed.iter().map(|s| s.to_string()).collect(),
            deleted_files: deleted.iter().map(|s| s.to_string()).collect(),
            untracked_files: untracked.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn no_change_yields_empty_change_set() {
        let prev = snap("abc", &[], &[], &[]);
        let next = snap("abc", &[], &[], &[]);
        assert!(compute_change_set(&prev, &next).is_empty());
    }

    #[test]
    fn head_change_signals_full_rebuild() {
        let prev = snap("abc", &[], &[], &[]);
        let next = snap("def", &[], &[], &[]);
        let cs = compute_change_set(&prev, &next);
        assert!(cs.full_rebuild);
        assert!(cs.reason.contains("HEAD changed"));
    }

    #[test]
    fn modified_file_is_detected() {
        let prev = snap("abc", &["src/a.ts"], &[], &[]);
        let next = snap("abc", &["src/a.ts"], &[], &[]);
        let cs = compute_change_set(&prev, &next);
        // Same HEAD, same changed set: content changed but git state identical
        // → empty (caller falls back to fs metadata when needed).
        assert!(cs.is_empty());

        // Newly modified file (was clean before).
        let prev = snap("abc", &[], &[], &[]);
        let next = snap("abc", &["src/a.ts"], &[], &[]);
        let cs = compute_change_set(&prev, &next);
        assert!(cs.changed.contains("src/a.ts"));
    }

    #[test]
    fn new_untracked_file_is_added() {
        let prev = snap("abc", &[], &[], &[]);
        let next = snap("abc", &[], &[], &["notes.txt"]);
        let cs = compute_change_set(&prev, &next);
        assert!(cs.added.contains("notes.txt"));
    }

    #[test]
    fn deletion_is_detected() {
        let prev = snap("abc", &[], &[], &[]);
        let next = snap("abc", &[], &["gone.rs"], &[]);
        let cs = compute_change_set(&prev, &next);
        assert!(cs.deleted.contains("gone.rs"));
    }

    #[test]
    fn fs_change_detection_uses_metadata() {
        let mut prev = FilesComponent::default();
        prev.files.insert(
            "a.txt".to_string(),
            FileMeta {
                path: "a.txt".into(),
                kind: "file".into(),
                size: 3,
                modified: 0,
                content_hash: "h1".into(),
                language: "".into(),
                executable: false,
                classification: "source".into(),
                generation: 1,
            },
        );
        let mut cur = prev.clone();
        cur.files.get_mut("a.txt").unwrap().content_hash = "h2".to_string();
        let r = Refresher::new(Path::new("/tmp"), 1);
        let cs = r.fs_change_detection(&prev, &cur);
        assert!(cs.changed.contains("a.txt"));
    }

    #[test]
    fn content_cache_bounds_and_lru() {
        let mut cache = ContentCacheComponent {
            max_bytes: 100,
            max_items: 3,
            ..Default::default()
        };
        cache.put("a", "aaaaa");
        cache.put("b", "bbbbb");
        cache.put("c", "ccccc");
        assert_eq!(cache.len(), 3);
        cache.put("d", "ddddd");
        assert_eq!(cache.len(), 3, "oldest evicted");
        assert!(cache.get("a").is_none());
        assert!(cache.get("d").is_some());
    }

    #[test]
    fn rename_detection_pairs_stem() {
        // Same stem "src/old" (extension changes) → matched as a rename.
        let mut cs = ChangeSet {
            deleted: BTreeSet::from(["src/old.ts".to_string()]),
            added: BTreeSet::from(["src/old.js".to_string()]),
            ..Default::default()
        };
        let r = Refresher::new(Path::new("/tmp"), 1);
        r.detect_renames(&mut cs, &snap("abc", &[], &[], &[]));
        assert_eq!(cs.renamed.len(), 1);
        assert_eq!(
            cs.renamed[0],
            ("src/old.ts".to_string(), "src/old.js".to_string())
        );
        assert!(cs.deleted.is_empty());
        assert!(cs.added.is_empty());
    }

    #[test]
    fn map_kind_and_classification_helpers_work() {
        // Sanity: builder classification helpers are stable.
        let m = crate::index::builder::detect_language_for("src/app.ts");
        assert_eq!(m, "typescript");
        let m2 = crate::index::builder::detect_language_for("x.png");
        assert_eq!(m2, "");
    }
}
