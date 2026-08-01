//! Incremental index - ties all indexes together with incremental update support

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use super::content_cache::ContentCache;
use super::dependency_graph::DependencyGraph;
use super::file_index::FileIndex;
use super::git_snapshot::GitSnapshotManager;
use super::symbol_index::SymbolIndex;
use super::test_mapping::TestMapping;

/// Combined incremental index for a repository
pub struct IncrementalIndex {
    /// Repository root
    root: PathBuf,
    /// File metadata index
    file_index: Arc<FileIndex>,
    /// Symbol index
    symbol_index: Arc<SymbolIndex>,
    /// Dependency graph
    dependency_graph: Arc<DependencyGraph>,
    /// Test mapping
    test_mapping: Arc<TestMapping>,
    /// Git snapshot manager
    git_manager: Arc<GitSnapshotManager>,
    /// Content cache
    content_cache: Arc<ContentCache>,
    /// Last full index time
    last_full_index: Arc<RwLock<SystemTime>>,
    /// Is index initialized
    initialized: Arc<RwLock<bool>>,
}

impl IncrementalIndex {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            file_index: Arc::new(FileIndex::new()),
            symbol_index: Arc::new(SymbolIndex::new()),
            dependency_graph: Arc::new(DependencyGraph::new()),
            test_mapping: Arc::new(TestMapping::new()),
            git_manager: Arc::new(GitSnapshotManager::new()),
            content_cache: Arc::new(ContentCache::default()),
            last_full_index: Arc::new(RwLock::new(SystemTime::now())),
            initialized: Arc::new(RwLock::new(false)),
        }
    }

    /// Initialize the index by doing a full scan
    pub fn initialize(&self) -> anyhow::Result<()> {
        // Capture initial git snapshot
        self.git_manager.capture(&self.root)?;

        // Walk the repository and index files
        self.walk_and_index()?;

        *self.initialized.write().unwrap() = true;
        *self.last_full_index.write().unwrap() = SystemTime::now();

        Ok(())
    }

    /// Walk repository and index files
    fn walk_and_index(&self) -> anyhow::Result<()> {
        for entry in ignore::Walk::new(&self.root) {
            let entry = entry?;
            let path = entry.path();

            // Skip hidden files and common ignore patterns
            if path
                .components()
                .any(|c| {
                    let s = c.as_os_str().to_string_lossy();
                    s.starts_with('.') || s == "target" || s == "node_modules" || s == "__pycache__"
                })
            {
                continue;
            }

            if path.is_file() {
                self.file_index.upsert(path).ok();
            }
        }

        Ok(())
    }

    /// Perform incremental update based on git changes
    pub fn incremental_update(&self) -> anyhow::Result<UpdateResult> {
        let previous_snapshot = self.git_manager.current();
        let _previous = previous_snapshot.ok_or_else(|| anyhow::anyhow!("No previous snapshot"))?;

        // Capture new snapshot
        self.git_manager.capture(&self.root)?;

        let current = self.git_manager.current().ok_or_else(|| anyhow::anyhow!("No current snapshot"))?;

        // Find changed files
        let mut updated_files = Vec::new();
        let mut deleted_files = Vec::new();

        for changed in &current.changed_files {
            match changed.status {
                super::git_snapshot::FileStatus::Added
                | super::git_snapshot::FileStatus::Modified
                | super::git_snapshot::FileStatus::Renamed => {
                    updated_files.push(changed.path.clone());
                }
                super::git_snapshot::FileStatus::Deleted => {
                    deleted_files.push(changed.path.clone());
                }
                _ => {}
            }
        }

        // Update indexes
        for path in &updated_files {
            self.file_index.upsert(path).ok();
            self.symbol_index.remove_file(path);
        }

        for path in &deleted_files {
            self.file_index.remove(path);
            self.symbol_index.remove_file(path);
            self.content_cache.remove(path);
        }

        *self.last_full_index.write().unwrap() = SystemTime::now();

        Ok(UpdateResult {
            updated: updated_files.len(),
            deleted: deleted_files.len(),
            total_files: self.file_index.len(),
        })
    }

    /// Check if a file needs reindexing
    pub fn needs_reindex(&self, path: &Path) -> bool {
        self.file_index.needs_reindex(path)
    }

    /// Get files that need reindexing
    pub fn files_needing_reindex(&self) -> Vec<PathBuf> {
        self.file_index
            .files()
            .into_iter()
            .filter(|p| self.needs_reindex(&p))
            .collect()
    }

    /// Check if index needs full rebuild
    pub fn needs_full_reindex(&self) -> bool {
        if !*self.initialized.read().unwrap() {
            return true;
        }

        if let Ok(last) = self.last_full_index.read() {
            last.elapsed().map_or(true, |d| d > Duration::from_secs(3600))
        } else {
            true
        }
    }

    /// Get file content from cache or filesystem
    pub fn get_content(&self, path: &Path) -> Option<String> {
        let path_buf = path.to_path_buf();

        // Try cache first
        if let Some(content) = self.content_cache.get(&path_buf) {
            return Some(content);
        }

        // Read from filesystem
        if let Ok(content) = std::fs::read_to_string(path) {
            self.content_cache.put(&path_buf, &content);
            return Some(content);
        }

        None
    }

    /// Get the file index
    pub fn file_index(&self) -> &Arc<FileIndex> {
        &self.file_index
    }

    /// Get the symbol index
    pub fn symbol_index(&self) -> &Arc<SymbolIndex> {
        &self.symbol_index
    }

    /// Get the dependency graph
    pub fn dependency_graph(&self) -> &Arc<DependencyGraph> {
        &self.dependency_graph
    }

    /// Get the test mapping
    pub fn test_mapping(&self) -> &Arc<TestMapping> {
        &self.test_mapping
    }

    /// Get the git manager
    pub fn git_manager(&self) -> &Arc<GitSnapshotManager> {
        &self.git_manager
    }

    /// Get the content cache
    pub fn content_cache(&self) -> &Arc<ContentCache> {
        &self.content_cache
    }

    /// Check if initialized
    pub fn is_initialized(&self) -> bool {
        *self.initialized.read().unwrap()
    }
}

/// Result of an incremental update
#[derive(Debug, Clone)]
pub struct UpdateResult {
    pub updated: usize,
    pub deleted: usize,
    pub total_files: usize,
}
