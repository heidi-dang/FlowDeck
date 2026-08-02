//! Platform-native file operations: true file identity and atomic
//! replacement.
//!
//! The standard library cannot provide a *strong* file identity on Windows:
//! `MetadataExt::file_index()` / `volume_serial_number()` are still behind
//! the unstable `windows_by_handle` feature gate, and size/mtime/attribute
//! comparisons can be forged (timestamps are settable, sizes are guessable,
//! attributes are coarse). This module asks the OS directly, from an
//! *opened handle*:
//!
//! - Windows: `GetFileInformationByHandle` → volume serial number + 64-bit
//!   file index (the same identity the kernel itself uses).
//! - Unix: `st_dev` + `st_ino` of the opened descriptor (`fstat`).
//!
//! `atomic_replace` provides an atomic "replace destination with source"
//! that never deletes the destination first and preserves it on failure:
//!
//! - Unix: `rename(2)` (atomic on the same filesystem).
//! - Windows: `ReplaceFileW` (preferred — preserves the destination's
//!   identity so open handles keep referring to the old file) with a
//!   `MoveFileExW` (`MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`)
//!   fallback for the first-publish case where the destination does not
//!   exist yet.

use std::path::Path;

/// Strong identity of a file, captured from an opened handle.
///
/// Equality on the platform-strong fields means "the same file object",
/// independent of size, mtime, or attribute flags. Size/time/attributes are
/// intentionally NOT part of identity equality — they can be forged or
/// change benignly while the file is still the same file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(windows)]
    volume_serial: u32,
    #[cfg(windows)]
    file_index_hi: u32,
    #[cfg(windows)]
    file_index_lo: u32,
    /// Supplementary only — never the sole identity. Used only on platforms
    /// with no strong identity available (not unix, not windows).
    #[cfg(not(any(unix, windows)))]
    len: u64,
    #[cfg(not(any(unix, windows)))]
    modified: Option<std::time::SystemTime>,
}

/// Capture the true identity of an already-open file handle.
///
/// The identity is read from the *handle itself*, so it always describes the
/// file that was actually opened — never a re-stat of the path (which could
/// have been swapped in between).
pub fn identity_of_file(file: &std::fs::File) -> std::io::Result<FileIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata()?;
        Ok(FileIdentity {
            dev: meta.dev(),
            ino: meta.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        identity_of_handle(file.as_raw_handle())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let meta = file.metadata()?;
        Ok(FileIdentity {
            len: meta.len(),
            modified: meta.modified().ok(),
        })
    }
}

/// Atomically replace the file at `dst` with the file at `src`.
///
/// Contract:
/// - `src` and `dst` must be on the same volume/filesystem;
/// - `dst` is never deleted first — there is no observable window where
///   `dst` is missing;
/// - on failure, `dst` is left exactly as it was;
/// - `src` is consumed (moved) on success;
/// - the replacement is flushed to the volume where the platform supports it
///   (`REPLACEFILE_WRITE_THROUGH` / `MOVEFILE_WRITE_THROUGH`).
///
/// Callers that may race with a reader holding `dst` open should retry with
/// a bounded budget on `ErrorKind::PermissionDenied` (Windows sharing
/// violations surface as `PermissionDenied`).
pub fn atomic_replace(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        // `rename(2)` is atomic on the same filesystem and replaces `dst` in
        // a single step, never exposing a missing `dst`.
        std::fs::rename(src, dst)
    }
    #[cfg(windows)]
    {
        atomic_replace_windows(src, dst)
    }
    #[cfg(not(any(unix, windows)))]
    {
        std::fs::rename(src, dst)
    }
}

#[cfg(windows)]
fn identity_of_handle(handle: *mut std::ffi::c_void) -> std::io::Result<FileIdentity> {
    let mut info = ffi::ByHandleFileInformation::default();
    // SAFETY: `handle` is a live, open file handle from `AsRawHandle` on an
    // owned `File`; `info` is a valid, writable struct of exactly the SDK
    // layout, so the kernel writes within bounds.
    let ok = unsafe { ffi::GetFileInformationByHandle(handle, &mut info) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(FileIdentity {
        volume_serial: info.volume_serial_number,
        file_index_hi: info.file_index_high,
        file_index_lo: info.file_index_low,
    })
}

#[cfg(windows)]
fn atomic_replace_windows(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let src_wide = wide(src);
    let dst_wide = wide(dst);

    // `ReplaceFileW` replaces `dst` with `src` as one atomic step and
    // flushes the replacement through (REPLACEFILE_WRITE_THROUGH). It fails
    // when `dst` does not exist yet (first publish) — fall back to
    // `MoveFileExW`, which creates `dst` when absent and replaces it
    // atomically when present. Both consume `src`.
    // SAFETY: both pointers reference null-terminated UTF-16 buffers
    // covering the full source/destination paths; `backup`, `exclude` and
    // `reserved` are NULL, so no memory is written through them.
    let replaced = unsafe {
        ffi::ReplaceFileW(
            dst_wide.as_ptr(),
            src_wide.as_ptr(),
            std::ptr::null(),
            ffi::REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced != 0 {
        return Ok(());
    }
    // SAFETY: `src_wide`/`dst_wide` are valid null-terminated UTF-16 path
    // buffers; the flags request replace-if-present plus write-through.
    let moved = unsafe {
        ffi::MoveFileExW(
            src_wide.as_ptr(),
            dst_wide.as_ptr(),
            ffi::MOVEFILE_REPLACE_EXISTING | ffi::MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Open `path` for read WITHOUT `FILE_SHARE_DELETE`, pinning it so that a
/// subsequent replace/delete of `path` fails with a sharing violation on
/// Windows. Used by tests to reproduce the "reader holds CURRENT open"
/// pointer-replacement failure (contract item 1).
#[cfg(windows)]
pub fn open_pinned(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a valid null-terminated UTF-16 path buffer; all
    // other parameters are constants or NULL.
    let handle = unsafe {
        ffi::CreateFileW(
            wide.as_ptr(),
            ffi::GENERIC_READ,
            ffi::FILE_SHARE_READ, // no FILE_SHARE_DELETE → pins the file
            std::ptr::null_mut(),
            ffi::OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `handle` is a valid handle from `CreateFileW`; the returned
    // `File` takes ownership and closes it on drop.
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

#[cfg(windows)]
mod ffi {
    //! Minimal hand-rolled declarations of the kernel32 APIs used here, so
    //! the crate needs no `windows`/`windows-sys` dependency. Layouts mirror
    //! the Windows SDK exactly — `ByHandleFileInformation` must match
    //! `BY_HANDLE_FILE_INFORMATION` field-for-field because the kernel
    //! writes the whole structure.

    use std::ffi::c_void;

    pub type Handle = *mut c_void;
    pub type Dword = u32;
    pub type Bool = i32;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    #[allow(dead_code)] // layout-completeness fields we do not read
    pub struct FileTime {
        pub low: Dword,
        pub high: Dword,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    #[allow(dead_code)] // layout-completeness fields we do not read
    pub struct ByHandleFileInformation {
        pub attributes: Dword,
        pub creation: FileTime,
        pub last_access: FileTime,
        pub last_write: FileTime,
        pub volume_serial_number: Dword,
        pub size_high: Dword,
        pub size_low: Dword,
        pub link_count: Dword,
        pub file_index_high: Dword,
        pub file_index_low: Dword,
    }

    pub const GENERIC_READ: Dword = 0x8000_0000;
    pub const FILE_SHARE_READ: Dword = 0x0000_0001;
    pub const OPEN_EXISTING: Dword = 3;
    pub const MOVEFILE_REPLACE_EXISTING: Dword = 0x0000_0001;
    pub const MOVEFILE_WRITE_THROUGH: Dword = 0x0000_0008;
    pub const REPLACEFILE_WRITE_THROUGH: Dword = 0x0000_0001;

    extern "system" {
        pub fn GetFileInformationByHandle(file: Handle, info: *mut ByHandleFileInformation)
            -> Bool;
        pub fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: Dword,
            exclude: *mut c_void,
            reserved: *mut c_void,
        ) -> Bool;
        pub fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: Dword) -> Bool;
        pub fn CreateFileW(
            path: *const u16,
            access: Dword,
            share: Dword,
            security: *mut c_void,
            disposition: Dword,
            flags_and_attributes: Dword,
            template: *mut c_void,
        ) -> Handle;
    }
}

#[cfg(test)]
mod winfs_tests {
    use super::*;

    #[test]
    fn atomic_replace_replaces_destination_atomically() {
        let tmp = tempfile::tempdir().unwrap();
        let dst = tmp.path().join("CURRENT");
        let src = tmp.path().join("CURRENT.tmp");
        std::fs::write(&dst, "old-pointer").unwrap();
        std::fs::write(&src, "new-pointer").unwrap();
        atomic_replace(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "new-pointer");
        assert!(!src.exists(), "source is consumed on success");
    }

    #[test]
    fn atomic_replace_creates_missing_destination() {
        // First-publish path: the pointer does not exist yet. On Windows
        // this exercises the MoveFileExW fallback.
        let tmp = tempfile::tempdir().unwrap();
        let dst = tmp.path().join("CURRENT");
        let src = tmp.path().join("CURRENT.tmp");
        std::fs::write(&src, "gen-1").unwrap();
        atomic_replace(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "gen-1");
    }

    #[test]
    fn atomic_replace_preserves_destination_when_source_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let dst = tmp.path().join("CURRENT");
        let src = tmp.path().join("does-not-exist.tmp");
        std::fs::write(&dst, "keep-me").unwrap();
        assert!(atomic_replace(&src, &dst).is_err());
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "keep-me");
    }

    #[cfg(windows)]
    #[test]
    fn atomic_replace_fails_while_destination_pinned_and_recovers() {
        let tmp = tempfile::tempdir().unwrap();
        let dst = tmp.path().join("CURRENT");
        let src = tmp.path().join("CURRENT.tmp");
        std::fs::write(&dst, "old-pointer").unwrap();
        std::fs::write(&src, "new-pointer").unwrap();

        let pinned = open_pinned(&dst).unwrap();
        let err = atomic_replace(&src, &dst).unwrap_err();
        assert_eq!(
            err.kind(),
            std::io::ErrorKind::PermissionDenied,
            "sharing violation must surface as PermissionDenied"
        );
        assert_eq!(
            std::fs::read_to_string(&dst).unwrap(),
            "old-pointer",
            "destination preserved while held open"
        );
        drop(pinned);

        // Once unpinned the same replace succeeds.
        atomic_replace(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "new-pointer");
    }

    #[test]
    fn identity_distinguishes_same_metadata_different_files() {
        // Two files with identical size, identical mtime, and (on Windows)
        // identical default attributes must still have distinct identities —
        // size/time/attrs are forgeable and must never be the identity.
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        let fixed = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::write(&a, "AAAA").unwrap();
        std::fs::write(&b, "BBBB").unwrap();
        // Pin both files to identical mtime/atime AFTER writing. A
        // read+write handle carries FILE_WRITE_ATTRIBUTES, which `set_times`
        // requires on Windows.
        for p in [&a, &b] {
            let f = std::fs::File::options()
                .read(true)
                .write(true)
                .open(p)
                .unwrap();
            f.set_times(
                std::fs::FileTimes::new()
                    .set_modified(fixed)
                    .set_accessed(fixed),
            )
            .unwrap();
            drop(f);
        }

        let fa = std::fs::File::open(&a).unwrap();
        let fb = std::fs::File::open(&b).unwrap();
        let ia = identity_of_file(&fa).unwrap();
        let ib = identity_of_file(&fb).unwrap();
        assert_ne!(ia, ib, "different files must have different identities");

        // The same file, opened twice, has the same identity.
        let fa2 = std::fs::File::open(&a).unwrap();
        assert_eq!(ia, identity_of_file(&fa2).unwrap());
    }
}
