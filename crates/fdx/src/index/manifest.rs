//! FDX persistent index — identity, manifest, and component schemas.
//!
//! Task 3 (Dev 3): a versioned per-repository, per-worktree persistent index
//! served by the fdxd daemon. This module defines the contracts:
//!
//! - [`IndexIdentity`]: canonical repository + worktree identity plus the
//!   freshness inputs (HEAD SHA, dirty fingerprint, config/ignore hashes).
//! - [`FdxIndexManifest`]: the versioned on-disk manifest.
//! - [`ComponentStatus`]: per-component generation state.
//!
//! The identity is what makes two worktrees never share mutable state: the
//! repository ID is a hash of the canonical repository root, and the worktree
//! ID is a hash of the worktree root. Raw paths never appear in global file
//! names — only short content-derived hashes do.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Schema version of the on-disk index format. Bump only on incompatible
/// changes; compatible changes add new optional fields.
pub const INDEX_SCHEMA_VERSION: u32 = 1;

/// Maximum length of any single path segment we create in the global state
/// directory. Keeps every generated path well under common filesystem limits
/// while remaining collision-resistant (64 hex chars = 256 bits of entropy).
pub const MAX_GENERATED_SEGMENT_LEN: usize = 64;

/// Length of generated hash segments (hex) used in state paths.
pub const HASH_SEGMENT_LEN: usize = 16;

// ─── Identity ───────────────────────────────────────────────────────────────

/// Canonical identity of one repository + one worktree.
///
/// Two worktrees of the same repository share `repository_id` but have
/// distinct `worktree_id`. Different users never collide because the state
/// directory itself is user-scoped (see [`crate::index::paths`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IndexIdentity {
    /// Canonical repository identity (hash of the repository root).
    pub repository_id: String,
    /// Worktree identity (hash of the worktree root).
    pub worktree_id: String,
    /// Hash of the normalized repository root path.
    pub repository_root_hash: String,
    /// Normalized repository root (kept in the manifest, never in file names).
    pub repository_root: String,
    /// Normalized worktree root.
    pub worktree_root: String,
}

// ─── Manifest ───────────────────────────────────────────────────────────────

/// Per-component persistence state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ComponentStatus {
    /// Component is present and valid in this generation.
    Ready,
    /// Component could not be built and is empty this generation.
    Unavailable,
    /// Component was quarantined due to corruption; rebuild pending.
    Quarantined,
}

/// Versioned on-disk index manifest.
///
/// The manifest is written last (after every component) and is the commit
/// point of a generation: a generation is only considered published once its
/// manifest exists and its checksums verify.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdxIndexManifest {
    /// Index schema version. Reject newer; migrate older explicitly.
    pub schema_version: u32,
    /// FDX binary version that produced this generation.
    pub fdx_version: String,
    /// Canonical repository identity.
    pub repository_id: String,
    /// Worktree identity.
    pub worktree_id: String,
    /// Hash of the normalized repository root path.
    pub repository_root_hash: String,
    /// Git HEAD SHA at generation time (empty when not a git repo).
    pub head_sha: String,
    /// Fingerprint of the dirty worktree state at generation time.
    pub dirty_fingerprint: String,
    /// Hash of relevant configuration.
    pub config_hash: String,
    /// Hash of ignore rules (.gitignore / .ignore / .fdignore).
    pub ignore_hash: String,
    /// Monotonic generation number. Higher is newer.
    pub generation: u64,
    /// ISO-8601 creation timestamp.
    pub created_at: String,
    /// ISO-8601 last-update timestamp.
    pub updated_at: String,
    /// Per-component status for this generation.
    pub components: ComponentsManifest,
    /// Content checksums for every persisted component file (hex).
    pub checksums: std::collections::BTreeMap<String, String>,
}

/// Per-component status and checksum references.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComponentsManifest {
    pub files: ComponentStatus,
    pub symbols: ComponentStatus,
    pub dependencies: ComponentStatus,
    pub test_mapping: ComponentStatus,
    pub git_state: ComponentStatus,
    pub content_cache: ComponentStatus,
}

impl Default for ComponentsManifest {
    fn default() -> Self {
        Self {
            files: ComponentStatus::Unavailable,
            symbols: ComponentStatus::Unavailable,
            dependencies: ComponentStatus::Unavailable,
            test_mapping: ComponentStatus::Unavailable,
            git_state: ComponentStatus::Unavailable,
            content_cache: ComponentStatus::Unavailable,
        }
    }
}

// ─── Component data (wire formats) ──────────────────────────────────────────

/// One row of the file metadata index.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileMeta {
    /// Normalized, repository-relative path (always `/` separators).
    pub path: String,
    /// File type: file | dir | symlink.
    pub kind: String,
    /// Size in bytes (dirs: 0).
    pub size: u64,
    /// Modification time (seconds since epoch, best effort).
    pub modified: u64,
    /// Content hash (SHA-256, hex, first 16 chars) where computed.
    pub content_hash: String,
    /// Detected language ("" when unknown/binary).
    pub language: String,
    /// Executable flag (unix).
    pub executable: bool,
    /// Classification: source | test | generated | binary | ignored.
    pub classification: String,
    /// Generation that last indexed this file.
    pub generation: u64,
}

/// One row of the symbol index.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SymbolMeta {
    /// Stable symbol id: sha256(qualified name + path) first 16 hex.
    pub id: String,
    /// Symbol name.
    pub name: String,
    /// Qualified name where available ("" when none).
    pub qualified_name: String,
    /// Symbol kind (function/class/struct/...).
    pub kind: String,
    /// Repository-relative file path.
    pub file: String,
    /// 1-based start line.
    pub line_start: usize,
    /// 1-based end line.
    pub line_end: usize,
    /// Exported/public status where detectable.
    pub exported: bool,
    /// Parent/container symbol id ("" when top-level).
    pub parent_id: String,
    /// Content hash of the source file at index time.
    pub source_hash: String,
    /// Generation that produced this symbol.
    pub generation: u64,
}

/// One row of the dependency graph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DependencyEdge {
    /// Repository-relative path of the importing file.
    pub from_file: String,
    /// Repository-relative path of the imported file (resolved) or "" when unresolved.
    pub to_file: String,
    /// Import string as written (module specifier / path).
    pub specifier: String,
    /// Import kind: import | require | dynamic | relative.
    pub kind: String,
    /// True when the target file could not be resolved within the repo.
    pub unresolved: bool,
    /// Generation that produced this edge.
    pub generation: u64,
}

/// One row of the test-to-source mapping.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TestMappingRow {
    /// Repository-relative path of the source file.
    pub source_file: String,
    /// Repository-relative path of the test file.
    pub test_file: String,
    /// Mapping basis: direct_import | naming | configured | package.
    pub basis: String,
    /// Confidence: 1.0 (direct) .. 0.0 (weak naming heuristic).
    pub confidence: f64,
}

/// Compact git state snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct GitStateSnapshot {
    /// HEAD SHA ("" when not a git repo).
    pub head_sha: String,
    /// Branch name, or "" when detached.
    pub branch: String,
    /// True when HEAD is detached.
    pub detached: bool,
    /// Tracked file changes (normalized relative paths).
    pub changed_files: Vec<String>,
    /// Renamed files: (old_path, new_path).
    pub renamed_files: Vec<(String, String)>,
    /// Deleted files.
    pub deleted_files: Vec<String>,
    /// Untracked files (respecting ignore rules).
    pub untracked_files: Vec<String>,
    /// Worktree identity.
    pub worktree_id: String,
    /// Snapshot generation.
    pub generation: u64,
}

/// One entry of the recent-content cache.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContentCacheEntry {
    /// Content-addressed key (sha256 of content, first 16 hex).
    pub key: String,
    /// Repository-relative file path.
    pub path: String,
    /// Size in bytes.
    pub size: usize,
    /// Last-access ordering token (monotonic counter; persisted for determinism).
    pub access_order: u64,
    /// The cached content (bounded).
    pub content: String,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Normalize a repository-relative path to forward slashes. Deterministic
/// across platforms; used as the canonical key everywhere in the index.
pub fn normalize_rel_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    }
}

/// Hash an identity component to a short hex segment (no raw paths in names).
pub fn short_hash(parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update(b"\0");
    }
    let digest = hasher.finalize();
    digest
        .iter()
        .take(HASH_SEGMENT_LEN / 2)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Generate a stable symbol id from qualified name + file path.
pub fn symbol_id(qualified_name: &str, file: &str) -> String {
    short_hash(&["sym", file, qualified_name])
}

/// Build a manifest with sane defaults for the given identity and generation.
#[allow(clippy::too_many_arguments)]
pub fn new_manifest(
    identity: &IndexIdentity,
    fdx_version: &str,
    generation: u64,
    now_iso: &str,
    head_sha: &str,
    dirty_fingerprint: &str,
    config_hash: &str,
    ignore_hash: &str,
) -> FdxIndexManifest {
    FdxIndexManifest {
        schema_version: INDEX_SCHEMA_VERSION,
        fdx_version: fdx_version.to_string(),
        repository_id: identity.repository_id.clone(),
        worktree_id: identity.worktree_id.clone(),
        repository_root_hash: identity.repository_root_hash.clone(),
        head_sha: head_sha.to_string(),
        dirty_fingerprint: dirty_fingerprint.to_string(),
        config_hash: config_hash.to_string(),
        ignore_hash: ignore_hash.to_string(),
        generation,
        created_at: now_iso.to_string(),
        updated_at: now_iso.to_string(),
        components: ComponentsManifest::default(),
        checksums: std::collections::BTreeMap::new(),
    }
}

/// Return a path only when it stays inside `root` after normalization.
/// Rejects symlink escapes and `..` traversal.
pub fn contains_path(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let root = root.to_path_buf();
    let mut joined = root.clone();
    joined.push(candidate);
    // Reject any `..` component outright: traversal is never allowed.
    if joined
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let normalized = joined.components().fold(PathBuf::new(), |acc, c| match c {
        std::path::Component::CurDir => acc,
        other => acc.join(other.as_os_str()),
    });
    if normalized.starts_with(&root) {
        Some(normalized)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::manifest::{HASH_SEGMENT_LEN, MAX_GENERATED_SEGMENT_LEN};

    #[test]
    fn normalize_rel_path_uses_forward_slashes() {
        let p = PathBuf::from("src").join("tools").join("fdx.rs");
        assert_eq!(normalize_rel_path(&p), "src/tools/fdx.rs");
    }

    #[test]
    fn short_hash_is_stable_and_short() {
        let a = short_hash(&["repo", "/a/b"]);
        let b = short_hash(&["repo", "/a/b"]);
        let c = short_hash(&["repo", "/a/c"]);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.len() <= MAX_GENERATED_SEGMENT_LEN);
        assert_eq!(a.len(), HASH_SEGMENT_LEN);
    }

    #[test]
    fn symbol_id_is_deterministic() {
        assert_eq!(
            symbol_id("fn foo", "src/lib.rs"),
            symbol_id("fn foo", "src/lib.rs")
        );
        assert_ne!(
            symbol_id("fn foo", "src/lib.rs"),
            symbol_id("fn bar", "src/lib.rs")
        );
    }

    #[test]
    fn manifest_defaults_are_unavailable() {
        let m = ComponentsManifest::default();
        assert_eq!(m.files, ComponentStatus::Unavailable);
    }

    #[test]
    fn contains_path_rejects_escape() {
        let root = Path::new("/repo");
        assert!(contains_path(root, Path::new("src/lib.rs")).is_some());
        assert!(contains_path(root, Path::new("../../etc/passwd")).is_none());
        assert!(contains_path(root, Path::new("a/../../etc")).is_none());
    }
}
