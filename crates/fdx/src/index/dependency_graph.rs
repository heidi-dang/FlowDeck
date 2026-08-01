//! Dependency graph for cross-file analysis

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// A dependency edge between files
#[derive(Debug, Clone, Eq, Hash, PartialEq)]
pub struct Dependency {
    pub from: PathBuf,
    pub to: PathBuf,
    pub kind: DependencyKind,
    pub line: Option<usize>,
}

/// Kind of dependency
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum DependencyKind {
    Import,
    Include,
    Require,
    Use,
    Reference,
}

/// Dependency graph for a repository
pub struct DependencyGraph {
    /// File to its dependencies (outgoing edges)
    dependencies: Arc<RwLock<HashMap<PathBuf, HashSet<Dependency>>>>,
    /// File to its dependents (incoming edges)
    dependents: Arc<RwLock<HashMap<PathBuf, HashSet<Dependency>>>>,
}

impl DependencyGraph {
    pub fn new() -> Self {
        Self {
            dependencies: Arc::new(RwLock::new(HashMap::new())),
            dependents: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Add a dependency
    pub fn add(&self, from: &Path, to: &Path, kind: DependencyKind, line: Option<usize>) {
        let dep = Dependency {
            from: from.to_path_buf(),
            to: to.to_path_buf(),
            kind,
            line,
        };

        let mut dependencies = self.dependencies.write().unwrap();
        let mut dependents = self.dependents.write().unwrap();

        // Add to outgoing edges
        dependencies
            .entry(from.to_path_buf())
            .or_insert_with(HashSet::new)
            .insert(dep.clone());

        // Add to incoming edges
        dependents
            .entry(to.to_path_buf())
            .or_insert_with(HashSet::new)
            .insert(dep);
    }

    /// Remove all dependencies for a file
    pub fn remove_file(&self, file: &Path) {
        let mut dependencies = self.dependencies.write().unwrap();
        let mut dependents = self.dependents.write().unwrap();

        // Remove from dependencies map
        if let Some(deps) = dependencies.remove(file) {
            // Remove from dependents of target files
            for dep in deps {
                if let Some(target_deps) = dependents.get_mut(&dep.to) {
                    target_deps.retain(|d| d.from != file);
                }
            }
        }

        // Remove from dependents map
        dependents.remove(file);
    }

    /// Get direct dependencies of a file
    pub fn dependencies_of(&self, file: &Path) -> Vec<Dependency> {
        let dependencies = self.dependencies.read().unwrap();
        dependencies
            .get(file)
            .map(|deps| deps.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Get direct dependents of a file
    pub fn dependents_of(&self, file: &Path) -> Vec<Dependency> {
        let dependents = self.dependents.read().unwrap();
        dependents
            .get(file)
            .map(|deps| deps.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Get all files that depend on a given file (recursive)
    pub fn all_dependents(&self, file: &Path) -> HashSet<PathBuf> {
        let mut result = HashSet::new();
        let mut to_visit = vec![file.to_path_buf()];

        while let Some(current) = to_visit.pop() {
            let dependents = self.dependents_of(&current);
            for dep in dependents {
                if result.insert(dep.from.clone()) {
                    to_visit.push(dep.from);
                }
            }
        }

        result.remove(file);
        result
    }

    /// Get all files that a given file depends on (recursive)
    pub fn all_dependencies(&self, file: &Path) -> HashSet<PathBuf> {
        let mut result = HashSet::new();
        let mut to_visit = vec![file.to_path_buf()];

        while let Some(current) = to_visit.pop() {
            let deps = self.dependencies_of(&current);
            for dep in deps {
                if result.insert(dep.to.clone()) {
                    to_visit.push(dep.to);
                }
            }
        }

        result.remove(file);
        result
    }

    /// Get files affected by changes to a given file
    pub fn affected_by(&self, file: &Path) -> Vec<PathBuf> {
        self.all_dependents(file).into_iter().collect()
    }

    /// Clear the graph
    pub fn clear(&self) {
        let mut dependencies = self.dependencies.write().unwrap();
        let mut dependents = self.dependents.write().unwrap();
        dependencies.clear();
        dependents.clear();
    }

    /// Number of files in the graph
    pub fn file_count(&self) -> usize {
        let dependencies = self.dependencies.read().unwrap();
        dependencies.len()
    }

    /// Total edge count
    pub fn edge_count(&self) -> usize {
        let dependencies = self.dependencies.read().unwrap();
        dependencies.values().map(|s| s.len()).sum()
    }
}

impl Default for DependencyGraph {
    fn default() -> Self {
        Self::new()
    }
}
