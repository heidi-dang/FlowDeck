//! Repository index management for the daemon

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use crate::reader::code::cache::AstCache;

/// Represents an indexed repository
#[derive(Debug, Clone)]
pub struct RepoIndex {
    /// Repository root path
    pub root: PathBuf,
    /// File metadata cache (path -> metadata)
    pub files: HashMap<PathBuf, FileMetadata>,
    /// Symbol index (symbol name -> locations)
    pub symbols: HashMap<String, Vec<SymbolLocation>>,
    /// Last indexed timestamp
    pub last_indexed: SystemTime,
    /// Worktree root (for git worktree isolation)
    pub worktree: Option<PathBuf>,
}

impl RepoIndex {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            files: HashMap::new(),
            symbols: HashMap::new(),
            last_indexed: SystemTime::now(),
            worktree: None,
        }
    }

    pub fn with_worktree(mut self, worktree: PathBuf) -> Self {
        self.worktree = Some(worktree);
        self
    }

    /// Check if a file needs reindexing
    pub fn needs_reindex(&self, path: &Path) -> bool {
        if let Some(metadata) = self.files.get(path) {
            if let Ok(current_mtime) = std::fs::metadata(path).and_then(|m| m.modified()) {
                return current_mtime > metadata.modified;
            }
        }
        true
    }

    /// Update index with changed files
    pub fn update_changed(&mut self, changed: &[PathBuf], deleted: &[PathBuf]) {
        // Remove deleted files
        for path in deleted {
            self.files.remove(path);
        }

        // Update changed files
        for path in changed {
            if let Ok(metadata) = std::fs::metadata(path) {
                let mtime = metadata.modified().unwrap_or(SystemTime::now());
                let size = metadata.len();
                self.files.insert(
                    path.clone(),
                    FileMetadata {
                        path: path.clone(),
                        modified: mtime,
                        size,
                        indexed_at: SystemTime::now(),
                    },
                );
            }
        }

        self.last_indexed = SystemTime::now();
    }
}

/// File metadata for the index
#[derive(Debug, Clone)]
pub struct FileMetadata {
    pub path: PathBuf,
    pub modified: SystemTime,
    pub size: u64,
    pub indexed_at: SystemTime,
}

/// Symbol location in a file
#[derive(Debug, Clone)]
pub struct SymbolLocation {
    pub file: PathBuf,
    pub line: usize,
    pub column: usize,
    pub symbol_type: String,
}

/// Repository index manager
#[derive(Debug, Clone)]
pub struct RepoIndexManager {
    /// Active repository indexes (path -> index)
    indexes: Arc<RwLock<HashMap<PathBuf, RepoIndex>>>,
    /// Global AST cache shared across indexes (reserved for future use)
    #[allow(dead_code)]
    cache: Arc<RwLock<AstCache>>,
}

impl RepoIndexManager {
    pub fn new() -> Self {
        Self {
            indexes: Arc::new(RwLock::new(HashMap::new())),
            cache: Arc::new(RwLock::new(AstCache::new())),
        }
    }

    /// Get or create an index for a repository
    pub fn get_or_create(&self, repo_path: &Path) -> Option<RepoIndex> {
        let repo_path = repo_path.canonicalize().ok()?;
        let mut indexes = self.indexes.write().ok()?;

        Some(
            indexes
                .entry(repo_path.clone())
                .or_insert_with(|| RepoIndex::new(repo_path))
                .clone(),
        )
    }

    /// Index a repository
    pub fn index_repo(&self, repo_path: &Path, force: bool) -> anyhow::Result<()> {
        let repo_path = repo_path.canonicalize()?;
        let mut indexes = self.indexes.write().map_err(|e| anyhow::anyhow!("Index lock poisoned: {}", e))?;

        let index = indexes.entry(repo_path.clone()).or_insert_with(|| {
            RepoIndex::new(repo_path.clone())
        });

        if force || index.last_indexed.elapsed().unwrap_or(Duration::ZERO) > Duration::from_secs(300) {
            self.reindex_repo(&repo_path, index)?;
        }

        Ok(())
    }

    fn reindex_repo(&self, repo_path: &Path, index: &mut RepoIndex) -> anyhow::Result<()> {
        // Clear existing data
        index.files.clear();
        index.symbols.clear();

        // Walk repository and index files
        self.walk_and_index(repo_path, index)?;

        index.last_indexed = SystemTime::now();
        Ok(())
    }

    fn walk_and_index(&self, dir: &Path, index: &mut RepoIndex) -> anyhow::Result<()> {
        for entry in ignore::Walk::new(dir) {
            let entry = entry?;
            let path = entry.path();

            // Skip hidden files, git dirs, target dirs
            if path
                .components()
                .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
            {
                continue;
            }

            if path.is_file() {
                if let Ok(metadata) = std::fs::metadata(path) {
                    let mtime = metadata.modified().unwrap_or(SystemTime::now());
                    index.files.insert(
                        path.to_path_buf(),
                        FileMetadata {
                            path: path.to_path_buf(),
                            modified: mtime,
                            size: metadata.len(),
                            indexed_at: SystemTime::now(),
                        },
                    );
                }
            }
        }
        Ok(())
    }

    /// Perform incremental update
    pub fn incremental_update(
        &self,
        repo_path: &Path,
        changed: &[PathBuf],
        deleted: &[PathBuf],
    ) -> anyhow::Result<()> {
        let repo_path = repo_path.canonicalize()?;
        let mut indexes = self.indexes.write().map_err(|e| anyhow::anyhow!("Index lock poisoned: {}", e))?;

        if let Some(index) = indexes.get_mut(&repo_path) {
            index.update_changed(changed, deleted);
        }

        Ok(())
    }

    /// Get index stats
    pub fn get_stats(&self) -> (usize, usize) {
        let indexes = self.indexes.read().unwrap();
        let file_count: usize = indexes.values().map(|i| i.files.len()).sum();
        (indexes.len(), file_count)
    }

    /// Check if repository is indexed
    pub fn is_indexed(&self, repo_path: &Path) -> bool {
        if let Ok(repo_path) = repo_path.canonicalize() {
            if let Ok(indexes) = self.indexes.read() {
                return indexes.contains_key(&repo_path);
            }
        }
        false
    }

    /// Remove index for a repository
    pub fn remove(&self, repo_path: &Path) -> bool {
        if let Ok(repo_path) = repo_path.canonicalize() {
            if let Ok(mut indexes) = self.indexes.write() {
                return indexes.remove(&repo_path).is_some();
            }
        }
        false
    }
}

impl Default for RepoIndexManager {
    fn default() -> Self {
        Self::new()
    }
}
