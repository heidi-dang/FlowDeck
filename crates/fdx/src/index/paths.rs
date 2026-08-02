//! Cross-platform state directory resolution for the FDX index.
//!
//! Requirements (Task 3 §4):
//! - `$XDG_CACHE_HOME` / FlowDeck state dir on Linux;
//! - user cache on macOS (`~/Library/Caches`);
//! - local application-data on Windows (`%LOCALAPPDATA%`);
//! - configurable override for tests and managed deployments (`FDX_INDEX_DIR`);
//! - private directory permissions where supported;
//! - bounded path length (all generated names are short hashes);
//! - Unicode and spaces supported;
//! - no hardcoded `/tmp`; no repository-local index by default.
//!
//! Layout:
//!   <state-root>/fdx-index/<repository_id>/<worktree_id>/<generation>/
//!
//! Only short hashes appear in directory/file names — raw repository paths
//! are never exposed in global file names.

use std::path::{Path, PathBuf};

/// Sub-directory of the state root where FDX indexes live.
pub const INDEX_NAMESPACE: &str = "fdx-index";

/// Environment variable override for the whole index state root.
pub const INDEX_DIR_ENV: &str = "FDX_INDEX_DIR";

/// Version marker written into the state root so we can detect and clean up
/// layouts from other schema versions.
pub const STATE_VERSION_FILE: &str = "index-state-v1";

/// Resolve the user-scoped index state root.
///
/// Priority:
/// 1. `FDX_INDEX_DIR` (explicit override — tests, managed deployments).
/// 2. `XDG_CACHE_HOME/fdx` (Linux).
/// 3. `~/Library/Caches/fdx` (macOS).
/// 4. `%LOCALAPPDATA%\fdx` (Windows).
/// 5. `~/.cache/fdx` (fallback).
pub fn index_state_root() -> PathBuf {
    if let Some(dir) = std::env::var_os(INDEX_DIR_ENV) {
        let p = PathBuf::from(dir);
        return p.join(INDEX_NAMESPACE);
    }

    let base = match std::env::var_os("XDG_CACHE_HOME") {
        Some(x) => PathBuf::from(x),
        None => {
            #[cfg(target_os = "macos")]
            {
                if let Some(home) = home_dir() {
                    home.join("Library").join("Caches")
                } else {
                    PathBuf::from(".cache")
                }
            }
            #[cfg(windows)]
            {
                if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                    PathBuf::from(local)
                } else if let Some(home) = home_dir() {
                    home.join("AppData").join("Local")
                } else {
                    PathBuf::from(".cache")
                }
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                if let Some(home) = home_dir() {
                    home.join(".cache")
                } else {
                    PathBuf::from(".cache")
                }
            }
            #[cfg(not(any(unix, windows)))]
            {
                PathBuf::from(".cache")
            }
        }
    };

    base.join("fdx").join(INDEX_NAMESPACE)
}

/// Private user home directory, with sane fallbacks.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Path to the directory holding all indexes for one repository.
pub fn repository_dir(root: &Path, repository_id: &str) -> PathBuf {
    root.join(repository_id)
}

/// Path to the directory holding all generations for one worktree.
pub fn worktree_dir(root: &Path, repository_id: &str, worktree_id: &str) -> PathBuf {
    repository_dir(root, repository_id).join(worktree_id)
}

/// Path to a specific generation directory.
pub fn generation_dir(worktree: &Path, generation: u64) -> PathBuf {
    worktree.join(format!("gen-{generation}"))
}

/// Path to the temporary sibling used while building a new generation.
pub fn generation_tmp_dir(worktree: &Path, generation: u64) -> PathBuf {
    worktree.join(format!("gen-{generation}.tmp"))
}

/// Path to the quarantine directory for corrupt components/generations.
pub fn quarantine_dir(worktree: &Path) -> PathBuf {
    worktree.join("quarantine")
}

/// Path to the current-generation pointer file (a small text file holding the
/// generation number). Written atomically.
pub fn current_pointer(worktree: &Path) -> PathBuf {
    worktree.join("CURRENT")
}

/// Validate that a generated segment is bounded and safe for use as a single
/// path component (no separators, no `..`, bounded length).
pub fn validate_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 128
        && !segment.contains('/')
        && !segment.contains('\\')
        && segment != "."
        && segment != ".."
}

/// Ensure the state root exists with private permissions where supported.
///
/// Returns the root on success. Errors if the root exists but is not a
/// directory. On unix, attempts `0700` on the state root.
pub fn ensure_state_root(root: &Path) -> std::io::Result<PathBuf> {
    let meta = std::fs::metadata(root);
    match meta {
        Ok(m) => {
            if !m.is_dir() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("index state root is not a directory: {}", root.display()),
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(root)?;
        }
        Err(e) => return Err(e),
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700));
    }

    Ok(root.to_path_buf())
}

/// Write the state version marker so incompatible future layouts are
/// detectable.
pub fn ensure_state_version(root: &Path) -> std::io::Result<()> {
    let marker = root.join(STATE_VERSION_FILE);
    if !marker.exists() {
        std::fs::write(
            &marker,
            format!("schema={}\n", crate::index::manifest::INDEX_SCHEMA_VERSION),
        )?;
    }
    Ok(())
}

/// Assert that every path segment we build stays within the given bound.
pub fn assert_bounded_path(path: &Path, max_len: usize) -> bool {
    path.to_string_lossy().len() <= max_len
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::manifest::HASH_SEGMENT_LEN;

    #[test]
    fn state_root_resolution_is_env_driven() {
        // Runs as a single test to avoid parallel env-var interference.
        let prev_override = std::env::var_os(INDEX_DIR_ENV);
        let prev_xdg = std::env::var_os("XDG_CACHE_HOME");

        // 1. Explicit override wins.
        std::env::set_var(INDEX_DIR_ENV, "/tmp/opencode/fdx-index-test");
        let root = index_state_root();
        assert!(root.starts_with("/tmp/opencode/fdx-index-test"));
        assert!(root.ends_with(INDEX_NAMESPACE));

        // 2. XDG_CACHE_HOME used when no override.
        std::env::remove_var(INDEX_DIR_ENV);
        std::env::set_var("XDG_CACHE_HOME", "/tmp/opencode/fdx-xdg");
        let root2 = index_state_root();
        assert!(root2.starts_with("/tmp/opencode/fdx-xdg/fdx"));

        // Restore.
        match prev_xdg {
            Some(v) => std::env::set_var("XDG_CACHE_HOME", v),
            None => std::env::remove_var("XDG_CACHE_HOME"),
        }
        match prev_override {
            Some(v) => std::env::set_var(INDEX_DIR_ENV, v),
            None => std::env::remove_var(INDEX_DIR_ENV),
        }
    }

    #[test]
    fn segments_are_bounded_and_safe() {
        assert!(validate_segment("0123456789abcdef"));
        assert!(validate_segment(&"a".repeat(HASH_SEGMENT_LEN)));
        assert!(!validate_segment("a/b"));
        assert!(!validate_segment(".."));
        assert!(!validate_segment(&"x".repeat(200)));
    }

    #[test]
    fn paths_are_composable() {
        let root = Path::new("/state");
        let repo = "r".repeat(HASH_SEGMENT_LEN);
        let wt = "w".repeat(HASH_SEGMENT_LEN);
        let g = generation_dir(&worktree_dir(root, &repo, &wt), 3);
        assert_eq!(g, Path::new("/state").join(&repo).join(&wt).join("gen-3"));
        let tmp = generation_tmp_dir(&worktree_dir(root, &repo, &wt), 4);
        assert!(tmp.to_string_lossy().ends_with("gen-4.tmp"));
    }

    #[test]
    fn ensure_state_root_creates_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("nested").join("root");
        let created = ensure_state_root(&root).unwrap();
        assert!(created.is_dir());
        ensure_state_version(&root).unwrap();
        assert!(root.join(STATE_VERSION_FILE).exists());
    }
}
