//! Recent-content cache for frequently accessed file content

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

/// Cached file content
#[derive(Debug, Clone)]
pub struct CachedContent {
    pub path: PathBuf,
    pub content: String,
    pub cached_at: SystemTime,
    pub access_count: usize,
    pub size_bytes: usize,
}

/// Recent-content cache with LRU eviction
pub struct ContentCache {
    /// Cache entries
    entries: Arc<RwLock<HashMap<PathBuf, CachedContent>>>,
    /// Access order for LRU
    access_order: Arc<RwLock<VecDeque<PathBuf>>>,
    /// Maximum cache size in bytes
    max_size_bytes: usize,
    /// Maximum entry count
    max_entries: usize,
    /// Current total size
    current_size: Arc<RwLock<usize>>,
}

impl ContentCache {
    pub fn new(max_size_bytes: usize, max_entries: usize) -> Self {
        Self {
            entries: Arc::new(RwLock::new(HashMap::new())),
            access_order: Arc::new(RwLock::new(VecDeque::new())),
            max_size_bytes,
            max_entries,
            current_size: Arc::new(RwLock::new(0)),
        }
    }

    /// Get content from cache
    pub fn get(&self, path: &PathBuf) -> Option<String> {
        let mut entries = self.entries.write().unwrap();
        let mut access_order = self.access_order.write().unwrap();

        if let Some(entry) = entries.get_mut(path) {
            // Update access info
            entry.access_count += 1;

            // Move to end of access order (most recently used)
            access_order.retain(|p| p != path);
            access_order.push_back(path.clone());

            return Some(entry.content.clone());
        }

        None
    }

    /// Put content in cache
    pub fn put(&self, path: &PathBuf, content: &str) {
        let size = content.len();

        // Evict if necessary
        self.evict_if_needed(size);

        let mut entries = self.entries.write().unwrap();
        let mut access_order = self.access_order.write().unwrap();
        let mut current_size = self.current_size.write().unwrap();

        // Remove existing entry if present
        if entries.contains_key(path) {
            if let Some(existing) = entries.get(path) {
                *current_size -= existing.size_bytes;
            }
            entries.remove(path);
            access_order.retain(|p| p != path);
        }

        // Add new entry
        let cached = CachedContent {
            path: path.clone(),
            content: content.to_string(),
            cached_at: SystemTime::now(),
            access_count: 0,
            size_bytes: size,
        };

        *current_size += size;
        entries.insert(path.clone(), cached);
        access_order.push_back(path.clone());
    }

    /// Remove entry from cache
    pub fn remove(&self, path: &PathBuf) {
        let mut entries = self.entries.write().unwrap();
        let mut access_order = self.access_order.write().unwrap();
        let mut current_size = self.current_size.write().unwrap();

        if let Some(entry) = entries.remove(path) {
            *current_size -= entry.size_bytes;
        }
        access_order.retain(|p| p != path);
    }

    /// Clear all cache entries
    pub fn clear(&self) {
        let mut entries = self.entries.write().unwrap();
        let mut access_order = self.access_order.write().unwrap();
        let mut current_size = self.current_size.write().unwrap();

        entries.clear();
        access_order.clear();
        *current_size = 0;
    }

    /// Get cache statistics
    pub fn stats(&self) -> CacheStats {
        let entries = self.entries.read().unwrap();
        let current_size = *self.current_size.read().unwrap();

        CacheStats {
            entry_count: entries.len(),
            size_bytes: current_size,
            max_size_bytes: self.max_size_bytes,
            max_entries: self.max_entries,
        }
    }

    /// Evict entries if needed to make room
    fn evict_if_needed(&self, incoming_size: usize) {
        let mut entries = self.entries.write().unwrap();
        let mut access_order = self.access_order.write().unwrap();
        let mut current_size = *self.current_size.read().unwrap();

        // Evict until we have room
        while (current_size + incoming_size > self.max_size_bytes
            || entries.len() >= self.max_entries)
            && !access_order.is_empty()
        {
            // Remove least recently used
            if let Some(lru_path) = access_order.pop_front() {
                if let Some(entry) = entries.remove(&lru_path) {
                    current_size -= entry.size_bytes;
                }
            }
        }

        *self.current_size.write().unwrap() = current_size;
    }

    /// Remove entries older than the specified duration
    pub fn evict_old(&self, max_age: Duration) {
        let cutoff = SystemTime::now() - max_age;
        let mut entries = self.entries.write().unwrap();
        let mut access_order = self.access_order.write().unwrap();
        let mut current_size = self.current_size.write().unwrap();

        let to_remove: Vec<PathBuf> = entries
            .values()
            .filter(|e| e.cached_at < cutoff)
            .map(|e| e.path.clone())
            .collect();

        for path in to_remove {
            if let Some(entry) = entries.remove(&path) {
                *current_size -= entry.size_bytes;
            }
            access_order.retain(|p| p != &path);
        }
    }
}

impl Default for ContentCache {
    fn default() -> Self {
        Self::new(50 * 1024 * 1024, 10000) // 50MB, 10000 entries
    }
}

/// Cache statistics
#[derive(Debug, Clone)]
pub struct CacheStats {
    pub entry_count: usize,
    pub size_bytes: usize,
    pub max_size_bytes: usize,
    pub max_entries: usize,
}

impl CacheStats {
    pub fn usage_ratio(&self) -> f64 {
        if self.max_size_bytes > 0 {
            self.size_bytes as f64 / self.max_size_bytes as f64
        } else {
            0.0
        }
    }
}
