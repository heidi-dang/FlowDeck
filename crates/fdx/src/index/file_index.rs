//! File metadata index

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, Duration};

/// File metadata entry
#[derive(Debug, Clone)]
pub struct FileMetadataEntry {
    pub path: PathBuf,
    pub modified: SystemTime,
    pub size: u64,
    pub hash: Option<String>,
    pub indexed_at: SystemTime,
    pub language: Option<String>,
}

impl FileMetadataEntry {
    pub fn new(path: PathBuf, modified: SystemTime, size: u64) -> Self {
        Self {
            path,
            modified,
            size,
            hash: None,
            indexed_at: SystemTime::now(),
            language: None,
        }
    }

    pub fn needs_reindex(&self, current_modified: SystemTime) -> bool {
        current_modified > self.modified
    }
}

/// File metadata index
pub struct FileIndex {
    entries: Arc<RwLock<HashMap<PathBuf, FileMetadataEntry>>>,
}

impl FileIndex {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Add or update a file
    pub fn upsert(&self, path: &Path) -> anyhow::Result<()> {
        let metadata = std::fs::metadata(path)?;
        let modified = metadata.modified()?;
        let size = metadata.len();

        let mut entry = FileMetadataEntry::new(path.to_path_buf(), modified, size);

        // Try to detect language
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            entry.language = Some(detect_language_from_ext(ext));
        }

        let mut entries = self.entries.write().unwrap();
        entries.insert(path.to_path_buf(), entry);

        Ok(())
    }

    /// Remove a file
    pub fn remove(&self, path: &Path) -> bool {
        let mut entries = self.entries.write().unwrap();
        entries.remove(path).is_some()
    }

    /// Get file metadata
    pub fn get(&self, path: &Path) -> Option<FileMetadataEntry> {
        let entries = self.entries.read().unwrap();
        entries.get(path).cloned()
    }

    /// Check if file needs reindexing
    pub fn needs_reindex(&self, path: &Path) -> bool {
        if let Some(entry) = self.get(path) {
            if let Ok(metadata) = std::fs::metadata(path) {
                let current_modified = metadata.modified().unwrap_or(SystemTime::now());
                return entry.needs_reindex(current_modified);
            }
        }
        true
    }

    /// Get all tracked files
    pub fn files(&self) -> Vec<PathBuf> {
        let entries = self.entries.read().unwrap();
        entries.keys().cloned().collect()
    }

    /// Get files with recent changes
    pub fn recently_changed(&self, since: Duration) -> Vec<PathBuf> {
        let cutoff = SystemTime::now() - since;
        let entries = self.entries.read().unwrap();
        entries
            .values()
            .filter(|e| e.modified > cutoff)
            .map(|e| e.path.clone())
            .collect()
    }

    /// Get total file count
    pub fn len(&self) -> usize {
        let entries = self.entries.read().unwrap();
        entries.len()
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        let entries = self.entries.read().unwrap();
        entries.is_empty()
    }

    /// Clear all entries
    pub fn clear(&self) {
        let mut entries = self.entries.write().unwrap();
        entries.clear();
    }
}

impl Default for FileIndex {
    fn default() -> Self {
        Self::new()
    }
}

fn detect_language_from_ext(ext: &str) -> String {
    match ext.to_lowercase().as_str() {
        "rs" => "Rust".to_string(),
        "ts" | "tsx" => "TypeScript".to_string(),
        "js" | "jsx" => "JavaScript".to_string(),
        "py" => "Python".to_string(),
        "java" => "Java".to_string(),
        "go" => "Go".to_string(),
        "rb" => "Ruby".to_string(),
        _ => "Unknown".to_string(),
    }
}
