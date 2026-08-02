//! In-memory component data for the FDX index.
//!
//! Each component is persisted as one JSON file (see [`crate::index::storage`])
//! and loaded into memory for query serving. Components are layered so an
//! incremental refresh updates only the affected layer.

use crate::index::manifest::{
    ContentCacheEntry, DependencyEdge, FileMeta, GitStateSnapshot, SymbolMeta, TestMappingRow,
};
use std::collections::{BTreeMap, HashMap, HashSet};

/// File metadata index: normalized relative path → metadata.
#[derive(Debug, Clone, Default)]
pub struct FilesComponent {
    pub files: BTreeMap<String, FileMeta>,
    /// Repository files rejected during the last build/refresh pass
    /// (path → structured reason). In-memory only: rejected files have NO
    /// row in any persisted component, so this map is never serialized.
    pub rejected: BTreeMap<String, String>,
}

/// Symbol index: symbol id → symbol metadata, plus a per-file index for fast
/// replacement and a name → ids index for duplicate-symbol queries.
#[derive(Debug, Clone, Default)]
pub struct SymbolsComponent {
    /// All symbols keyed by stable id.
    pub by_id: BTreeMap<String, SymbolMeta>,
    /// file path → ids of symbols in that file (for incremental replace).
    pub by_file: HashMap<String, Vec<String>>,
    /// symbol name → ids (duplicates allowed).
    pub by_name: HashMap<String, Vec<String>>,
}

impl SymbolsComponent {
    /// Insert one symbol, maintaining all indexes.
    pub fn insert(&mut self, sym: SymbolMeta) {
        self.by_id.insert(sym.id.clone(), sym.clone());
        self.by_file
            .entry(sym.file.clone())
            .or_default()
            .push(sym.id.clone());
        self.by_name
            .entry(sym.name.clone())
            .or_default()
            .push(sym.id.clone());
    }

    /// Remove every symbol belonging to `file`. Returns removed ids.
    pub fn remove_file(&mut self, file: &str) -> Vec<String> {
        let Some(ids) = self.by_file.remove(file) else {
            return Vec::new();
        };
        for id in &ids {
            if let Some(sym) = self.by_id.remove(id) {
                if let Some(names) = self.by_name.get_mut(&sym.name) {
                    names.retain(|n| n != id);
                    if names.is_empty() {
                        self.by_name.remove(&sym.name);
                    }
                }
            }
        }
        ids
    }

    /// Replace all symbols for a file (used by incremental refresh).
    pub fn replace_file(&mut self, file: &str, symbols: Vec<SymbolMeta>) {
        self.remove_file(file);
        for sym in symbols {
            self.insert(sym);
        }
    }
}

/// Dependency graph: forward edges, reverse dependants, unresolved refs.
#[derive(Debug, Clone, Default)]
pub struct DependenciesComponent {
    /// from_file → list of edges.
    pub forward: HashMap<String, Vec<DependencyEdge>>,
    /// to_file → list of importing files (reverse dependants).
    pub reverse: HashMap<String, Vec<String>>,
    /// Importing files that have at least one unresolved reference.
    pub unresolved: HashSet<String>,
}

impl DependenciesComponent {
    /// Replace the forward edges for one file, updating reverse/unresolved.
    pub fn replace_file(&mut self, from: &str, edges: Vec<DependencyEdge>) {
        // Remove old edges for this file.
        if let Some(old) = self.forward.remove(from) {
            for e in old {
                if !e.unresolved && !e.to_file.is_empty() {
                    if let Some(rev) = self.reverse.get_mut(&e.to_file) {
                        rev.retain(|f| f != from);
                        if rev.is_empty() {
                            self.reverse.remove(&e.to_file);
                        }
                    }
                }
            }
        }
        self.unresolved.remove(from);

        // Insert new edges.
        for e in edges {
            if e.unresolved || e.to_file.is_empty() {
                self.unresolved.insert(from.to_string());
                continue;
            }
            self.forward
                .entry(from.to_string())
                .or_default()
                .push(e.clone());
            self.reverse
                .entry(e.to_file.clone())
                .or_default()
                .push(from.to_string());
        }
    }

    /// Remove a deleted file from the graph entirely.
    pub fn remove_file(&mut self, file: &str) {
        if let Some(old) = self.forward.remove(file) {
            for e in old {
                if !e.unresolved && !e.to_file.is_empty() {
                    if let Some(rev) = self.reverse.get_mut(&e.to_file) {
                        rev.retain(|f| f != file);
                        if rev.is_empty() {
                            self.reverse.remove(&e.to_file);
                        }
                    }
                }
            }
        }
        self.unresolved.remove(file);
    }

    /// Reverse dependants of a file, deterministically sorted.
    pub fn dependants_of(&self, file: &str) -> Vec<String> {
        let mut v = self.reverse.get(file).cloned().unwrap_or_default();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// All edges from a file.
    pub fn edges_from(&self, file: &str) -> Vec<DependencyEdge> {
        self.forward.get(file).cloned().unwrap_or_default()
    }
}

/// Test-to-source mapping.
#[derive(Debug, Clone, Default)]
pub struct TestMappingComponent {
    /// source_file → rows.
    pub by_source: HashMap<String, Vec<TestMappingRow>>,
    /// test_file → source files it maps to.
    pub by_test: HashMap<String, Vec<String>>,
}

impl TestMappingComponent {
    pub fn insert(&mut self, row: TestMappingRow) {
        self.by_source
            .entry(row.source_file.clone())
            .or_default()
            .push(row.clone());
        self.by_test
            .entry(row.test_file.clone())
            .or_default()
            .push(row.source_file.clone());
    }

    pub fn remove_source(&mut self, file: &str) {
        if let Some(rows) = self.by_source.remove(file) {
            for row in rows {
                if let Some(tests) = self.by_test.get_mut(&row.test_file) {
                    tests.retain(|s| s != file);
                    if tests.is_empty() {
                        self.by_test.remove(&row.test_file);
                    }
                }
            }
        }
    }
}

/// Git state snapshot component.
#[derive(Debug, Clone, Default)]
pub struct GitStateComponent {
    pub snapshot: GitStateSnapshot,
}

/// Bounded recent-content cache.
///
/// Content-addressed (key = sha256 of content), bounded by max bytes and max
/// items, LRU-evicted deterministically by access order.
#[derive(Debug, Clone)]
pub struct ContentCacheComponent {
    /// key → entry.
    pub entries: HashMap<String, ContentCacheEntry>,
    /// path → key (for invalidation on content change).
    pub by_path: HashMap<String, String>,
    /// Sorted access-order queue (key, order).
    pub order: Vec<(String, u64)>,
    /// Next access-order token.
    pub next_order: u64,
    /// Current total bytes.
    pub total_bytes: usize,
    /// Max bytes.
    pub max_bytes: usize,
    /// Max items.
    pub max_items: usize,
    /// Generation stamped onto entries inserted by [`Self::put`]. The
    /// publishing layer re-stamps every entry with the published generation
    /// before serialization; this field keeps in-memory entries consistent
    /// between refreshes.
    pub generation: u64,
}

impl Default for ContentCacheComponent {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            by_path: HashMap::new(),
            order: Vec::new(),
            next_order: 1,
            total_bytes: 0,
            max_bytes: 4 * 1024 * 1024, // 4 MiB default
            max_items: 512,
            generation: 0,
        }
    }
}

impl ContentCacheComponent {
    /// Store content under a path (only if it fits the budget).
    pub fn put(&mut self, path: &str, content: &str) -> Option<String> {
        let size = content.len();
        if size > self.max_bytes {
            return None; // single item too large: don't cache
        }
        let key = crate::index::manifest::content_cache_key(path, content);
        // Drop an existing entry for the same path first.
        if let Some(old_key) = self.by_path.get(path).cloned() {
            self.remove_by_key(&old_key);
        }
        let entry = ContentCacheEntry {
            key: key.clone(),
            path: path.to_string(),
            size,
            access_order: self.next_order,
            content: content.to_string(),
            generation: self.generation,
        };
        self.next_order += 1;
        self.entries.insert(key.clone(), entry);
        self.by_path.insert(path.to_string(), key.clone());
        self.order.push((key.clone(), self.next_order - 1));
        self.total_bytes += size;
        self.evict();
        Some(key)
    }

    /// Touch an entry (LRU) and return its content, validating size.
    pub fn get(&mut self, path: &str) -> Option<String> {
        let key = self.by_path.get(path)?.clone();
        let entry = self.entries.get_mut(&key)?;
        entry.access_order = self.next_order;
        self.next_order += 1;
        let content = entry.content.clone();
        self.order.sort_by_key(|(_, o)| *o);
        Some(content)
    }

    /// Invalidate on content change: remove a path from the cache.
    pub fn invalidate_path(&mut self, path: &str) {
        if let Some(key) = self.by_path.remove(path) {
            self.remove_by_key(&key);
        }
    }

    /// Remove an entry by key (maintains budgets).
    fn remove_by_key(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.by_path.remove(&entry.path);
            self.total_bytes = self.total_bytes.saturating_sub(entry.size);
        }
        self.order.retain(|(k, _)| k != key);
    }

    /// Evict oldest entries until within budget.
    fn evict(&mut self) {
        self.order.sort_by_key(|(_, o)| *o);
        while self.total_bytes > self.max_bytes || self.entries.len() > self.max_items {
            let Some((key, _)) = self.order.first().cloned() else {
                break;
            };
            self.remove_by_key(&key);
        }
    }

    /// Total persisted entry count.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the cache is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
