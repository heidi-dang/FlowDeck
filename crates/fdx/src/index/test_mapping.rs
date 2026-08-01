//! Test mapping - maps test files to the code they test

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// A test mapping entry
#[derive(Debug, Clone)]
pub struct TestMappingEntry {
    /// Path to the test file
    pub test_file: PathBuf,
    /// Path to the source file being tested
    pub source_file: PathBuf,
    /// Name of the test
    pub test_name: Option<String>,
    /// Test framework (rust, jest, pytest, etc.)
    pub framework: String,
}

/// Test mapping index
pub struct TestMapping {
    /// Test file to source files
    test_to_source: Arc<RwLock<HashMap<PathBuf, HashSet<PathBuf>>>>,
    /// Source file to test files
    source_to_test: Arc<RwLock<HashMap<PathBuf, HashSet<PathBuf>>>>,
    /// Test name index (test_name -> test_file)
    by_name: Arc<RwLock<HashMap<String, PathBuf>>>,
}

impl TestMapping {
    pub fn new() -> Self {
        Self {
            test_to_source: Arc::new(RwLock::new(HashMap::new())),
            source_to_test: Arc::new(RwLock::new(HashMap::new())),
            by_name: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Add a test mapping
    pub fn add(&self, test_file: &Path, source_file: &Path, test_name: Option<String>, _framework: &str) {
        let mut test_to_source = self.test_to_source.write().unwrap();
        let mut source_to_test = self.source_to_test.write().unwrap();
        let mut by_name = self.by_name.write().unwrap();

        // Map test -> source
        test_to_source
            .entry(test_file.to_path_buf())
            .or_insert_with(HashSet::new)
            .insert(source_file.to_path_buf());

        // Map source -> test
        source_to_test
            .entry(source_file.to_path_buf())
            .or_insert_with(HashSet::new)
            .insert(test_file.to_path_buf());

        // Index by test name
        if let Some(name) = test_name {
            by_name.insert(name, test_file.to_path_buf());
        }
    }

    /// Remove mappings for a test file
    pub fn remove_test(&self, test_file: &Path) {
        let mut test_to_source = self.test_to_source.write().unwrap();
        let mut source_to_test = self.source_to_test.write().unwrap();

        if let Some(sources) = test_to_source.remove(test_file) {
            for source in sources {
                if let Some(tests) = source_to_test.get_mut(&source) {
                    tests.remove(test_file);
                }
            }
        }
    }

    /// Remove mappings for a source file
    pub fn remove_source(&self, source_file: &Path) {
        let mut test_to_source = self.test_to_source.write().unwrap();
        let mut source_to_test = self.source_to_test.write().unwrap();

        if let Some(tests) = source_to_test.remove(source_file) {
            for test in tests {
                if let Some(sources) = test_to_source.get_mut(&test) {
                    sources.remove(source_file);
                }
            }
        }
    }

    /// Get test files for a source file
    pub fn tests_for(&self, source_file: &Path) -> Vec<PathBuf> {
        let source_to_test = self.source_to_test.read().unwrap();
        source_to_test
            .get(source_file)
            .map(|t| t.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Get source files for a test file
    pub fn sources_for(&self, test_file: &Path) -> Vec<PathBuf> {
        let test_to_source = self.test_to_source.read().unwrap();
        test_to_source
            .get(test_file)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Find test file by name
    pub fn find_test(&self, name: &str) -> Option<PathBuf> {
        let by_name = self.by_name.read().unwrap();
        by_name.get(name).cloned()
    }

    /// Get all tests
    pub fn all_tests(&self) -> Vec<PathBuf> {
        let test_to_source = self.test_to_source.read().unwrap();
        test_to_source.keys().cloned().collect()
    }

    /// Get all source files with tests
    pub fn all_sources(&self) -> Vec<PathBuf> {
        let source_to_test = self.source_to_test.read().unwrap();
        source_to_test.keys().cloned().collect()
    }

    /// Clear all mappings
    pub fn clear(&self) {
        let mut test_to_source = self.test_to_source.write().unwrap();
        let mut source_to_test = self.source_to_test.write().unwrap();
        let mut by_name = self.by_name.write().unwrap();
        test_to_source.clear();
        source_to_test.clear();
        by_name.clear();
    }

    /// Test count
    pub fn test_count(&self) -> usize {
        let test_to_source = self.test_to_source.read().unwrap();
        test_to_source.len()
    }

    /// Source count
    pub fn source_count(&self) -> usize {
        let source_to_test = self.source_to_test.read().unwrap();
        source_to_test.len()
    }
}

impl Default for TestMapping {
    fn default() -> Self {
        Self::new()
    }
}
