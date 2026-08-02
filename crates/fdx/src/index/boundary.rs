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

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

// ─── Guarded repository reads ────────────────────────────────────────────────
//
// Every repository-content read inside one indexing pass goes through
// [`read_repository_file`] (content) or [`repository_file_metadata`]
// (metadata only, for binary files whose bytes must not be loaded into
// memory). Both perform the full boundary + TOCTOU guard:
//   symlink_metadata → canonicalize → containment → reject special files
//   → open/stat → post-check revalidation → file-identity check.
// The [`RepositoryReader`] wrapper additionally caches results per pass so
// each candidate path is read at most once — the content hash, language,
// symbols, dependencies, and cache entries all derive from the same
// verified bytes, which eliminates mid-pass TOCTOU windows entirely.

/// File identity + size info captured by a guarded read. A clonable subset
/// of `std::fs::Metadata` (which is not `Clone`), sufficient for `FileMeta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardedFileInfo {
    pub len: u64,
    pub modified: std::time::SystemTime,
    pub executable: bool,
    /// True when the candidate entry itself is a symlink (resolving inside
    /// the repository root).
    pub is_symlink: bool,
}

/// A repository file read through the full boundary + TOCTOU guard.
#[derive(Debug, PartialEq, Eq)]
pub struct GuardedRepositoryFile {
    /// Verified content bytes of the resolved target.
    pub bytes: Vec<u8>,
    /// Canonical resolved target path (inside the canonical repository root).
    pub canonical_path: PathBuf,
    /// Metadata of the file actually opened (not the pre-read stat).
    pub info: GuardedFileInfo,
}

/// Why a repository file was rejected for indexing.
///
/// Rejected files are excluded from EVERY index component: no file row, no
/// symbols, no dependency edges, no test mappings, no cache entries. Stale
/// rows for a previously-indexed path are removed on rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepositoryReadRejection {
    /// The canonical target resolves outside the canonical repository root.
    OutsideRoot,
    /// A symlink in the chain is broken (target missing).
    BrokenSymlink,
    /// Symlink loop while resolving.
    SymlinkLoop,
    /// The file changed identity between the pre-read validation and the
    /// post-read revalidation (TOCTOU swap).
    ChangedDuringRead,
    /// The entry is not a regular file (directory, device, socket, fifo).
    NotRegularFile,
    /// The path could not be resolved (permissions, IO during resolution).
    Unresolvable,
    /// IO failure while opening or reading the file.
    Io,
}

impl std::fmt::Display for RepositoryReadRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::OutsideRoot => "outside-repo-root",
            Self::BrokenSymlink => "broken-symlink",
            Self::SymlinkLoop => "symlink-loop",
            Self::ChangedDuringRead => "changed-during-read",
            Self::NotRegularFile => "not-regular-file",
            Self::Unresolvable => "unresolvable",
            Self::Io => "io-error",
        };
        f.write_str(s)
    }
}

/// Shared resolution guard. Resolves `candidate` to a canonical regular file
/// inside `root` and returns:
/// - whether the candidate entry itself is a symlink,
/// - the canonical resolved path,
/// - the resolved target's metadata (stat, follows links).
///
/// No content is read here. Failure returns a [`RepositoryReadRejection`].
fn guard_resolve(
    root: &Path,
    candidate: &Path,
) -> Result<(bool, PathBuf, std::fs::Metadata), RepositoryReadRejection> {
    // 1. Inspect WITHOUT following links (a symlink entry is allowed only
    //    when its resolved target stays inside the root).
    let entry_meta = std::fs::symlink_metadata(candidate).map_err(|e| classify_resolve(&e))?;
    let is_symlink = entry_meta.file_type().is_symlink();
    if !is_symlink && !entry_meta.file_type().is_file() {
        // Directory, device, socket, fifo — never indexable content.
        return Err(RepositoryReadRejection::NotRegularFile);
    }

    // 2. Resolve the canonical target (follows symlink chains).
    let canon = candidate.canonicalize().map_err(|e| classify_resolve(&e))?;

    // 3. Containment: the resolved target must live inside the canonical
    //    repository root. `Path::starts_with` is component-based, so a
    //    sibling `/repo2` can never match root `/repo`.
    if !canon.starts_with(root) {
        return Err(RepositoryReadRejection::OutsideRoot);
    }

    // 4. The resolved target itself must be a regular file (a symlink may
    //    point at a directory, device, socket, ...).
    let target_meta = std::fs::metadata(&canon).map_err(|_| RepositoryReadRejection::Unresolvable)?;
    if !target_meta.is_file() {
        return Err(RepositoryReadRejection::NotRegularFile);
    }

    Ok((is_symlink, canon, target_meta))
}

/// Post-read/stat revalidation: `candidate` must still resolve to the same
/// canonical target inside `root`, and the file at the path now must still
/// be the same file as `base` (the file that was actually opened or
/// stat'ed). Any mismatch means a swap happened mid-read.
fn revalidate(
    root: &Path,
    candidate: &Path,
    canon: &Path,
    base: &std::fs::Metadata,
) -> Result<(), RepositoryReadRejection> {
    let post_canon = match candidate.canonicalize() {
        Ok(c) => c,
        Err(_) => return Err(RepositoryReadRejection::ChangedDuringRead),
    };
    if post_canon != *canon || !post_canon.starts_with(root) {
        return Err(RepositoryReadRejection::ChangedDuringRead);
    }
    let post_meta = match std::fs::metadata(&post_canon) {
        Ok(m) => m,
        Err(_) => return Err(RepositoryReadRejection::ChangedDuringRead),
    };
    if !same_file(base, &post_meta) {
        return Err(RepositoryReadRejection::ChangedDuringRead);
    }
    Ok(())
}

/// Read a repository file under the full boundary + TOCTOU guard.
///
/// - `repository_root`: the canonical repository root.
/// - `candidate`: the absolute path to read (may be a symlink whose target
///   resolves inside the root).
///
/// Returns the verified bytes, canonical path, and file metadata, or a
/// [`RepositoryReadRejection`] (never a partially-verified result).
pub fn read_repository_file(
    repository_root: &Path,
    candidate: &Path,
) -> Result<GuardedRepositoryFile, RepositoryReadRejection> {
    let root = repository_root
        .canonicalize()
        .map_err(|_| RepositoryReadRejection::Unresolvable)?;
    let (is_symlink, canon, target_meta) = guard_resolve(&root, candidate)?;

    // 5. Open + read the resolved target.
    use std::io::Read;
    let mut f = std::fs::File::open(&canon).map_err(|_| RepositoryReadRejection::Io)?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).map_err(|_| RepositoryReadRejection::Io)?;
    let opened_meta = f.metadata().map_err(|_| RepositoryReadRejection::Io)?;

    // 6. The file actually opened must be the file validated at step 4 (a
    //    swap between stat and open is caught here).
    if !same_file(&target_meta, &opened_meta) {
        return Err(RepositoryReadRejection::ChangedDuringRead);
    }

    // 7. Post-read revalidation: the candidate must still resolve to the
    //    same canonical target inside the root (a swap to an external
    //    symlink between steps 1-4 and the read is caught here).
    revalidate(&root, candidate, &canon, &opened_meta)?;

    Ok(GuardedRepositoryFile {
        bytes,
        canonical_path: canon,
        info: GuardedFileInfo {
            len: opened_meta.len(),
            modified: opened_meta.modified().unwrap_or(std::time::UNIX_EPOCH),
            executable: is_executable(&opened_meta),
            is_symlink,
        },
    })
}

/// Metadata-only guarded check: like [`read_repository_file`] but without
/// reading content. Used for binary files whose bytes must never be loaded
/// into memory (the boundary + TOCTOU guard still applies in full).
pub fn repository_file_metadata(
    repository_root: &Path,
    candidate: &Path,
) -> Result<GuardedFileInfo, RepositoryReadRejection> {
    let root = repository_root
        .canonicalize()
        .map_err(|_| RepositoryReadRejection::Unresolvable)?;
    let (is_symlink, canon, target_meta) = guard_resolve(&root, candidate)?;
    revalidate(&root, candidate, &canon, &target_meta)?;
    Ok(GuardedFileInfo {
        len: target_meta.len(),
        modified: target_meta.modified().unwrap_or(std::time::UNIX_EPOCH),
        executable: is_executable(&target_meta),
        is_symlink,
    })
}

/// Per-pass guarded repository reader.
///
/// Every repository-content read inside one indexing pass must go through
/// this reader so that:
/// - the full boundary + TOCTOU guard applies to every read;
/// - each candidate path is read at most once per pass (subsequent reads
///   return the cached guarded bytes), so the content hash, language,
///   symbols, dependencies, and cache entries all derive from the same
///   verified bytes — closing mid-pass TOCTOU windows entirely.
#[derive(Debug)]
pub struct RepositoryReader {
    root: PathBuf,
    reads: RefCell<HashMap<PathBuf, Result<Arc<GuardedRepositoryFile>, RepositoryReadRejection>>>,
    metas: RefCell<HashMap<PathBuf, Result<GuardedFileInfo, RepositoryReadRejection>>>,
}

impl RepositoryReader {
    /// Create a reader scoped to `root` (canonicalized defensively on first
    /// use). `root` is the repository root being indexed.
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            reads: RefCell::new(HashMap::new()),
            metas: RefCell::new(HashMap::new()),
        }
    }

    /// The repository root this reader is scoped to.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Guarded read with per-pass caching. Each candidate path is read at
    /// most once; later calls return the cached guarded bytes.
    pub fn read(
        &self,
        abs: &Path,
    ) -> Result<Arc<GuardedRepositoryFile>, RepositoryReadRejection> {
        if let Some(cached) = self.reads.borrow().get(abs) {
            return match cached {
                Ok(g) => Ok(g.clone()),
                Err(r) => Err(r.clone()),
            };
        }
        let result = read_repository_file(&self.root, abs).map(Arc::new);
        self.reads
            .borrow_mut()
            .insert(abs.to_path_buf(), result.clone());
        result
    }

    /// Guarded metadata check with per-pass caching (no content read).
    pub fn metadata(&self, abs: &Path) -> Result<GuardedFileInfo, RepositoryReadRejection> {
        if let Some(cached) = self.metas.borrow().get(abs) {
            return match cached {
                Ok(info) => Ok(info.clone()),
                Err(r) => Err(r.clone()),
            };
        }
        let result = repository_file_metadata(&self.root, abs);
        self.metas
            .borrow_mut()
            .insert(abs.to_path_buf(), result.clone());
        result
    }
}

/// Classify a resolve/stat error into a rejection.
fn classify_resolve(e: &std::io::Error) -> RepositoryReadRejection {
    if e.kind() == std::io::ErrorKind::NotFound {
        return RepositoryReadRejection::BrokenSymlink;
    }
    // Symlink loops surface as ELOOP on unix (40 on Linux, 62 on macOS).
    // `ErrorKind::FilesystemLoop` is unstable, so detect via the raw code.
    #[cfg(unix)]
    if let Some(code) = e.raw_os_error() {
        if code == 40 || code == 62 {
            return RepositoryReadRejection::SymlinkLoop;
        }
    }
    RepositoryReadRejection::Unresolvable
}

/// Whether two metadata snapshots describe the same file.
#[cfg(unix)]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(windows)]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // Prefer the volume + file-index identity when the platform exposes it;
    // fall back to size + last-write-time otherwise.
    match (
        a.volume_serial_number(),
        a.file_index(),
        b.volume_serial_number(),
        b.file_index(),
    ) {
        (Some(v1), Some(i1), Some(v2), Some(i2)) => v1 == v2 && i1 == i2,
        _ => a.len() == b.len() && a.modified().ok() == b.modified().ok(),
    }
}

#[cfg(not(any(unix, windows)))]
fn same_file(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    a.len() == b.len() && a.modified().ok() == b.modified().ok()
}

/// Whether the file has any executable bit set (unix only).
#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod guarded_read_tests {
    use super::*;
    use std::fs;

    fn tmp_root() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        (tmp, root)
    }

    #[cfg(unix)]
    fn make_symlink(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[cfg(not(unix))]
    fn make_symlink(target: &Path, link: &Path) {
        std::os::windows::fs::symlink_file(target, link).unwrap();
    }

    #[test]
    fn regular_file_reads_guarded_bytes() {
        let (_tmp, root) = tmp_root();
        fs::write(root.join("a.ts"), "export const x = 1;\n").unwrap();
        let g = read_repository_file(&root, &root.join("a.ts")).unwrap();
        assert_eq!(g.bytes, b"export const x = 1;\n");
        assert_eq!(g.canonical_path, root.join("a.ts").canonicalize().unwrap());
        assert_eq!(g.info.len, 20);
        assert!(!g.info.is_symlink);
    }

    #[test]
    fn internal_symlink_reads_target_content() {
        let (_tmp, root) = tmp_root();
        fs::write(root.join("target.ts"), "pub fn x() {}\n").unwrap();
        make_symlink(Path::new("target.ts"), &root.join("link.ts"));
        let g = read_repository_file(&root, &root.join("link.ts")).unwrap();
        assert_eq!(g.bytes, b"pub fn x() {}\n");
        assert!(g.info.is_symlink);
    }

    #[test]
    fn external_symlink_rejected_outside_root() {
        let (_tmp, root) = tmp_root();
        let ext = tempfile::tempdir().unwrap();
        fs::write(ext.path().join("secret.txt"), "exfil").unwrap();
        make_symlink(&ext.path().join("secret.txt"), &root.join("evil.txt"));
        assert_eq!(
            read_repository_file(&root, &root.join("evil.txt")),
            Err(RepositoryReadRejection::OutsideRoot)
        );
    }

    #[test]
    fn broken_symlink_rejected() {
        let (_tmp, root) = tmp_root();
        make_symlink(Path::new("missing-target.ts"), &root.join("broken.ts"));
        assert_eq!(
            read_repository_file(&root, &root.join("broken.ts")),
            Err(RepositoryReadRejection::BrokenSymlink)
        );
    }

    #[test]
    fn missing_file_rejected() {
        let (_tmp, root) = tmp_root();
        assert_eq!(
            read_repository_file(&root, &root.join("nope.ts")),
            Err(RepositoryReadRejection::BrokenSymlink)
        );
    }

    #[test]
    fn directory_rejected_not_regular() {
        let (_tmp, root) = tmp_root();
        fs::create_dir(root.join("sub")).unwrap();
        assert_eq!(
            read_repository_file(&root, &root.join("sub")),
            Err(RepositoryReadRejection::NotRegularFile)
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_directory_rejected() {
        let (_tmp, root) = tmp_root();
        fs::create_dir(root.join("sub")).unwrap();
        std::os::unix::fs::symlink("sub", root.join("dirlink")).unwrap();
        assert_eq!(
            read_repository_file(&root, &root.join("dirlink")),
            Err(RepositoryReadRejection::NotRegularFile)
        );
    }

    #[test]
    fn reader_returns_cached_guarded_bytes_across_swap() {
        // Read-once-per-pass: after the guarded read, a swap to an external
        // symlink must NOT change what later layers see — they derive from
        // the same cached, verified bytes.
        let (_tmp, root) = tmp_root();
        let ext = tempfile::tempdir().unwrap();
        fs::write(ext.path().join("secret.txt"), "EXFIL").unwrap();
        fs::write(root.join("a.ts"), "safe-content").unwrap();

        let reader = RepositoryReader::new(&root);
        let first = reader.read(&root.join("a.ts")).unwrap();
        assert_eq!(first.bytes, b"safe-content");

        fs::remove_file(root.join("a.ts")).unwrap();
        make_symlink(&ext.path().join("secret.txt"), &root.join("a.ts"));

        let second = reader.read(&root.join("a.ts")).unwrap();
        assert_eq!(second.bytes, b"safe-content", "cached guarded bytes used");
    }

    #[test]
    fn reader_rejects_external_symlink_and_caches() {
        let (_tmp, root) = tmp_root();
        let ext = tempfile::tempdir().unwrap();
        fs::write(ext.path().join("secret.txt"), "exfil").unwrap();
        make_symlink(&ext.path().join("secret.txt"), &root.join("evil.txt"));
        let reader = RepositoryReader::new(&root);
        assert_eq!(
            reader.read(&root.join("evil.txt")),
            Err(RepositoryReadRejection::OutsideRoot)
        );
        // Cached: second call returns the same rejection without re-reading.
        assert_eq!(
            reader.read(&root.join("evil.txt")),
            Err(RepositoryReadRejection::OutsideRoot)
        );
    }

    #[test]
    fn metadata_rejects_external_symlink() {
        let (_tmp, root) = tmp_root();
        let ext = tempfile::tempdir().unwrap();
        fs::write(ext.path().join("secret.bin"), "binary").unwrap();
        make_symlink(&ext.path().join("secret.bin"), &root.join("evil.bin"));
        assert_eq!(
            repository_file_metadata(&root, &root.join("evil.bin")),
            Err(RepositoryReadRejection::OutsideRoot)
        );
    }

    #[test]
    fn metadata_reports_size_and_flags() {
        let (_tmp, root) = tmp_root();
        fs::write(root.join("run.sh"), "#!/bin/sh\n").unwrap();
        let info = repository_file_metadata(&root, &root.join("run.sh")).unwrap();
        assert_eq!(info.len, 10);
        assert!(!info.is_symlink);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(root.join("run.sh")).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(root.join("run.sh"), perms).unwrap();
            let info = repository_file_metadata(&root, &root.join("run.sh")).unwrap();
            assert!(info.executable);
        }
    }
}
