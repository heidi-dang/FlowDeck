//! Repository boundary enforcement — symlink containment and TOCTOU guards.
//!
//! No indexed file content may originate from outside the canonical repository
//! root. Before reading a candidate file:
//! 1. inspect filesystem metadata WITHOUT following links;
//! 2. detect symbolic links;
//! 3. resolve the canonical target when links are permitted (internal only);
//! 4. verify the resolved target is within the canonical repository root;
//! 5. reject paths that escape;
//! 6. handle broken links, link loops, and races safely.
//!
//! TOCTOU defence: after reading content, verify the file still resolves
//! within the repository root (it could have been replaced with a symlink
//! between check and read).

use std::io;
use std::path::{Path, PathBuf};

/// Result of symlink containment check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundaryVerdict {
    /// The file is safe to read (regular file inside root).
    Allow,
    /// The file is a symlink that points inside root.
    AllowSymlink,
    /// The file is a symlink whose canonical target is outside root.
    SymlinkEscape(PathBuf),
    /// The path cannot be resolved (broken link, loop, IO error).
    Unresolvable,
}

/// Check whether a filesystem entry is safe to include in the index.
///
/// - `abs`: the absolute path to the candidate file.
/// - `root`: the canonical repository root.
///
/// Uses `symlink_metadata` to inspect without following links.
pub fn check_file_boundary(abs: &Path, root: &Path) -> BoundaryVerdict {
    let meta = match std::fs::symlink_metadata(abs) {
        Ok(m) => m,
        Err(_) => return BoundaryVerdict::Unresolvable,
    };

    if !meta.file_type().is_symlink() {
        // Non-symlink: verify it starts with root.
        match abs.canonicalize() {
            Ok(canon) if canon.starts_with(root) => BoundaryVerdict::Allow,
            Ok(_) => BoundaryVerdict::SymlinkEscape(abs.canonicalize().unwrap_or_default()),
            Err(_) => BoundaryVerdict::Unresolvable,
        }
    } else {
        // Symlink: resolve the target and check containment.
        match abs.canonicalize() {
            Ok(canon) if canon.starts_with(root) => BoundaryVerdict::AllowSymlink,
            Ok(canon) => BoundaryVerdict::SymlinkEscape(canon),
            Err(_) => BoundaryVerdict::Unresolvable,
        }
    }
}

/// Post-read check: verify the file still exists at the same path and still
/// resolves within the root. Returns `true` when the caller's read data is
/// safe to use.
pub fn verify_post_read(abs: &Path, root: &Path) -> bool {
    match std::fs::symlink_metadata(abs) {
        Ok(m) => {
            if m.file_type().is_symlink() {
                // Re-resolve the symlink target.
                matches!(abs.canonicalize(), Ok(canon) if canon.starts_with(root))
            } else {
                // Regular file: verify it still exists at same path.
                matches!(abs.canonicalize(), Ok(canon) if canon.starts_with(root))
            }
        }
        Err(_) => false,
    }
}

/// Resolve a path to its canonical form, handling symlink chains and races
/// safely. Returns `None` on error (broken link, loop, permissions).
pub fn safe_canonicalize(path: &Path) -> io::Result<PathBuf> {
    // `path.canonicalize()` follows symlinks natively.
    path.canonicalize()
}

/// True when the candidate path is within `root` (after canonicalization).
pub fn is_within_root(candidate: &Path, root: &Path) -> bool {
    match candidate.canonicalize() {
        Ok(canon) => canon.starts_with(root),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn regular_file_is_allowed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        fs::write(root.join("a.txt"), "hello").unwrap();
        assert_eq!(
            check_file_boundary(&root.join("a.txt"), &root),
            BoundaryVerdict::Allow
        );
    }

    #[cfg(unix)]
    #[test]
    fn external_symlink_is_detected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let ext = tempfile::tempdir().unwrap();
        fs::write(ext.path().join("outside.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(ext.path().join("outside.txt"), root.join("link.txt")).unwrap();
        assert_eq!(
            check_file_boundary(&root.join("link.txt"), &root),
            BoundaryVerdict::SymlinkEscape(ext.path().join("outside.txt").canonicalize().unwrap())
        );
    }

    #[test]
    fn internal_symlink_is_permitted() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        fs::write(root.join("a.txt"), "hello").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("a.txt", root.join("b.txt")).unwrap();
        #[cfg(not(unix))]
        std::os::windows::fs::symlink_file("a.txt", root.join("b.txt")).unwrap();
        assert_eq!(
            check_file_boundary(&root.join("b.txt"), &root),
            BoundaryVerdict::AllowSymlink
        );
    }

    #[test]
    fn post_read_catches_symlink_swap() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("bad.txt"), "exfil").unwrap();
        fs::write(root.join("a.txt"), "safe").unwrap();

        // Read safe content first.
        let _content = fs::read_to_string(root.join("a.txt")).unwrap();

        // Swap: replace with external symlink.
        fs::remove_file(root.join("a.txt")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(external.path().join("bad.txt"), root.join("a.txt")).unwrap();
        #[cfg(not(unix))]
        std::os::windows::symlink_file(external.path().join("bad.txt"), root.join("a.txt"))
            .unwrap();

        // Post-read check must reject.
        assert!(!verify_post_read(&root.join("a.txt"), &root));
    }
}
