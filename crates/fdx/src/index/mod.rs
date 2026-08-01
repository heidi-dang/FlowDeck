//! Warm Incremental Indexes
//!
//! File metadata index
//! Symbol index
//! Dependency graph
//! Test mapping
//! Git snapshot
//! Recent-content cache
//! Only changed files reindexed

pub mod file_index;
pub mod symbol_index;
pub mod dependency_graph;
pub mod test_mapping;
pub mod git_snapshot;
pub mod content_cache;
pub mod incremental;

pub use file_index::FileIndex;
pub use symbol_index::SymbolIndex;
pub use dependency_graph::DependencyGraph;
pub use test_mapping::TestMapping;
pub use git_snapshot::GitSnapshot;
pub use content_cache::ContentCache;
pub use incremental::IncrementalIndex;
