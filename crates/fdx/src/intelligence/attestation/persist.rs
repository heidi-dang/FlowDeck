//! Atomic, contained, and path-safe persistence for verification attestations.

use crate::intelligence::attestation::canonical::canonicalize_to_vec;
use crate::intelligence::attestation::model::VerificationAttestation;
use crate::intelligence::runtime::sha256_bytes;
use rustix::fd::AsFd;
use rustix::fs::{fstat, linkat, openat, unlinkat, AtFlags, FileType, Mode, OFlags};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum permitted size for an attestation artifact file (16 MiB).
pub const MAX_ATTESTATION_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

thread_local! {
    pub static TEST_BEFORE_PUBLISH_HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
    pub static TEST_INJECT_LINK_FAILURE: std::cell::Cell<Option<std::io::ErrorKind>> = const { std::cell::Cell::new(None) };
}

pub fn set_test_before_publish_hook<F: Fn() + 'static>(hook: F) {
    TEST_BEFORE_PUBLISH_HOOK.with(|h| *h.borrow_mut() = Some(Box::new(hook)));
}

pub fn clear_test_before_publish_hook() {
    TEST_BEFORE_PUBLISH_HOOK.with(|h| *h.borrow_mut() = None);
}

pub fn set_test_inject_link_failure(kind: Option<std::io::ErrorKind>) {
    TEST_INJECT_LINK_FAILURE.with(|f| f.set(kind));
}

/// Directory where verification attestations are persisted.
pub fn attestations_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".fdx").join("attestations")
}

/// Compute the deterministic path for an attestation artifact.
pub fn attestation_file_path(repo_root: &Path, run_id: &str, attestation_sha256: &str) -> PathBuf {
    attestations_dir(repo_root).join(format!("{}.{}.json", run_id, attestation_sha256))
}

/// Validate path safety for run_id.
fn validate_identifier(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains('\0')
        || id.starts_with('.')
    {
        return Err(format!(
            "invalid identifier (path traversal detected): {:?}",
            id
        ));
    }
    Ok(())
}

/// Read up to `max_bytes` from an already-opened file handle with hard cap and size checks.
pub fn read_bounded_file(file: &mut File, max_bytes: u64) -> Result<Vec<u8>, String> {
    let stat = fstat(file.as_fd()).map_err(|e| format!("failed to fstat file handle: {}", e))?;
    let file_type = FileType::from_raw_mode(stat.st_mode);

    if file_type == FileType::Symlink {
        return Err("file handle is a symlink (symlinks are rejected)".to_string());
    }
    if file_type != FileType::RegularFile {
        return Err("file handle is not a regular file".to_string());
    }
    if (stat.st_size as u64) > max_bytes {
        return Err(format!(
            "file exceeds maximum allowed size ({} bytes > {} max)",
            stat.st_size, max_bytes
        ));
    }

    let mut take_reader = Read::take(file, max_bytes + 1);
    let mut bytes = Vec::with_capacity(std::cmp::min(stat.st_size as usize, 64 * 1024));
    take_reader
        .read_to_end(&mut bytes)
        .map_err(|e| format!("failed to read file content: {}", e))?;

    if (bytes.len() as u64) > max_bytes {
        return Err(format!(
            "file grew beyond maximum allowed size during read (exceeded {} bytes)",
            max_bytes
        ));
    }
    Ok(bytes)
}

/// Validated canonical managed attestation directory context.
#[derive(Debug)]
pub struct ManagedAttestationDir {
    pub repo_root: PathBuf,
    pub fdx_dir: PathBuf,
    pub attestations_dir: PathBuf,
    pub dir_file: File,
}

impl Clone for ManagedAttestationDir {
    fn clone(&self) -> Self {
        Self {
            repo_root: self.repo_root.clone(),
            fdx_dir: self.fdx_dir.clone(),
            attestations_dir: self.attestations_dir.clone(),
            dir_file: self
                .dir_file
                .try_clone()
                .expect("failed to clone dir handle"),
        }
    }
}

impl ManagedAttestationDir {
    /// Validate that repo_root, .fdx, and .fdx/attestations form a strict, non-symlink containment jail,
    /// and return the opened directory handle for race-free relative operations.
    pub fn ensure(repo_root: &Path) -> Result<Self, String> {
        let canonical_repo = repo_root
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize repository root {:?}: {}", repo_root, e))?;

        let repo_meta = fs::symlink_metadata(&canonical_repo)
            .map_err(|e| format!("failed to inspect repository root {:?}: {}", repo_root, e))?;
        if repo_meta.file_type().is_symlink() || !repo_meta.is_dir() {
            return Err(format!(
                "repository root {:?} is not a directory",
                repo_root
            ));
        }

        let fdx_dir = repo_root.join(".fdx");
        if fdx_dir.exists() || fdx_dir.is_symlink() {
            let meta = fs::symlink_metadata(&fdx_dir)
                .map_err(|e| format!("failed to read .fdx metadata {:?}: {}", fdx_dir, e))?;
            if meta.file_type().is_symlink() {
                return Err(format!(
                    ".fdx directory cannot be a symlink (escape detected): {:?}",
                    fdx_dir
                ));
            }
            if !meta.is_dir() {
                return Err(format!(".fdx exists but is not a directory: {:?}", fdx_dir));
            }
            let canonical_fdx = fdx_dir
                .canonicalize()
                .map_err(|e| format!("cannot canonicalize .fdx directory {:?}: {}", fdx_dir, e))?;
            if !canonical_fdx.starts_with(&canonical_repo) {
                return Err(format!(
                    ".fdx directory points outside repository jail: {:?}",
                    fdx_dir
                ));
            }
        } else {
            fs::create_dir_all(&fdx_dir)
                .map_err(|e| format!("failed to create .fdx directory {:?}: {}", fdx_dir, e))?;
        }

        let attestations_dir = fdx_dir.join("attestations");
        if attestations_dir.exists() || attestations_dir.is_symlink() {
            let meta = fs::symlink_metadata(&attestations_dir).map_err(|e| {
                format!(
                    "failed to read attestations directory metadata {:?}: {}",
                    attestations_dir, e
                )
            })?;
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "attestations directory cannot be a symlink (escape detected): {:?}",
                    attestations_dir
                ));
            }
            if !meta.is_dir() {
                return Err(format!(
                    "attestations path exists but is not a directory: {:?}",
                    attestations_dir
                ));
            }
            let canonical_att = attestations_dir.canonicalize().map_err(|e| {
                format!(
                    "cannot canonicalize attestations directory {:?}: {}",
                    attestations_dir, e
                )
            })?;
            let canonical_fdx = fdx_dir
                .canonicalize()
                .map_err(|e| format!("cannot canonicalize .fdx directory {:?}: {}", fdx_dir, e))?;
            if !canonical_att.starts_with(&canonical_fdx) {
                return Err(format!(
                    "attestations directory points outside .fdx directory jail: {:?}",
                    attestations_dir
                ));
            }
        } else {
            fs::create_dir_all(&attestations_dir).map_err(|e| {
                format!(
                    "failed to create attestations directory {:?}: {}",
                    attestations_dir, e
                )
            })?;
        }

        // Open directory handle safely
        let dir_file = File::open(&attestations_dir).map_err(|e| {
            format!(
                "failed to open managed attestations directory handle {:?}: {}",
                attestations_dir, e
            )
        })?;

        // Verify open handle stat is directory
        let stat = fstat(dir_file.as_fd())
            .map_err(|e| format!("failed to fstat managed attestations directory: {}", e))?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
            return Err(format!(
                "managed attestations handle is not a directory: {:?}",
                attestations_dir
            ));
        }

        Ok(Self {
            repo_root: canonical_repo,
            fdx_dir,
            attestations_dir,
            dir_file,
        })
    }
}

/// Explicit classification of an attestation input path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttestationSource {
    Managed {
        path: PathBuf,
        filename_sha256: String,
    },
    External {
        path: PathBuf,
        expected_sha256: String,
    },
}

/// Check if a path syntactically targets the managed .fdx namespace.
pub fn is_managed_path_syntax(repo_root: &Path, file_path: &Path) -> bool {
    if file_path.starts_with(".fdx") {
        return true;
    }
    let fdx_full = repo_root.join(".fdx");
    if file_path.starts_with(&fdx_full) {
        return true;
    }
    file_path.components().any(|c| c.as_os_str() == ".fdx")
}

/// Classify an attestation source based on canonical repository containment and symlink safety.
pub fn classify_attestation_source(
    repo_root: &Path,
    file_path: &Path,
    expected_sha256: Option<&str>,
) -> Result<AttestationSource, String> {
    let resolved_path = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        repo_root.join(file_path)
    };

    let is_managed_syntax = is_managed_path_syntax(repo_root, file_path)
        || is_managed_path_syntax(repo_root, &resolved_path);

    if is_managed_syntax {
        let managed_jail = ManagedAttestationDir::ensure(repo_root).map_err(|e| {
            format!(
                "Managed attestation directory safety violation for {:?}: {}",
                resolved_path, e
            )
        })?;

        let canonical_att_dir = managed_jail.attestations_dir.canonicalize().map_err(|e| {
            format!(
                "failed to canonicalize managed attestations dir {:?}: {}",
                managed_jail.attestations_dir, e
            )
        })?;

        let canonical_file = resolved_path.canonicalize().map_err(|e| {
            format!(
                "failed to canonicalize attestation file {:?}: {}",
                resolved_path, e
            )
        })?;

        let parent = canonical_file
            .parent()
            .ok_or_else(|| format!("cannot determine parent directory of {:?}", canonical_file))?;

        if parent == canonical_att_dir {
            if let Some(fn_sha) = extract_filename_digest(&resolved_path) {
                return Ok(AttestationSource::Managed {
                    path: resolved_path,
                    filename_sha256: fn_sha,
                });
            } else {
                return Err(format!(
                    "Managed attestation file {:?} has invalid content-address filename format (<run_id>.<sha256>.json)",
                    resolved_path
                ));
            }
        } else {
            return Err(format!(
                "Attestation path {:?} targets .fdx namespace but is outside .fdx/attestations directory",
                resolved_path
            ));
        }
    }

    if let Some(exp_sha) = expected_sha256 {
        Ok(AttestationSource::External {
            path: resolved_path,
            expected_sha256: exp_sha.to_ascii_lowercase(),
        })
    } else {
        Err(format!(
            "External attestation file {:?} is not in the canonical managed directory (.fdx/attestations). External verification requires --expected-sha256 <sha256> integrity anchor.",
            resolved_path
        ))
    }
}

/// Persist an attestation artifact atomically and no-clobber to `.fdx/attestations/<run_id>.<attestation_sha256>.json`.
pub fn persist_attestation(
    repo_root: &Path,
    attestation: &VerificationAttestation,
) -> Result<(PathBuf, String), String> {
    let run_id = &attestation.predicate.run.run_id;
    validate_identifier(run_id)?;

    let canonical_bytes = canonicalize_to_vec(attestation)?;
    let attestation_sha256 = sha256_bytes(&canonical_bytes);

    let managed_jail = ManagedAttestationDir::ensure(repo_root)?;
    let dir = managed_jail.attestations_dir;
    let target_filename = format!("{}.{}.json", run_id, attestation_sha256);
    let target_path = dir.join(&target_filename);

    let pid = std::process::id();
    let prefix = if attestation_sha256.len() >= 8 {
        &attestation_sha256[..8]
    } else {
        &attestation_sha256
    };

    // Open unique temp file relative to dir_file with create-new retry loop
    let mut temp_filename = String::new();
    let mut temp_fd_opt = None;

    for _ in 0..5 {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!(".{}.{}.tmp-{}-{}-{}", run_id, prefix, pid, nonce, counter);

        match openat(
            &managed_jail.dir_file,
            &name,
            OFlags::CREATE | OFlags::EXCL | OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_bits_truncate(0o644),
        ) {
            Ok(fd) => {
                temp_filename = name;
                temp_fd_opt = Some(fd);
                break;
            }
            Err(rustix::io::Errno::EXIST) => continue,
            Err(e) => {
                return Err(format!(
                    "failed to create temporary attestation file {:?} safely: {}",
                    name, e
                ));
            }
        }
    }

    let temp_fd = temp_fd_opt.ok_or_else(|| {
        format!(
            "failed to allocate unique temporary filename for run_id {}",
            run_id
        )
    })?;

    let write_res = (|| -> std::io::Result<()> {
        let mut file = File::from(temp_fd);
        file.write_all(&canonical_bytes)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = unlinkat(&managed_jail.dir_file, &temp_filename, AtFlags::empty());
        return Err(format!(
            "failed to write temporary attestation {:?}: {}",
            temp_filename, e
        ));
    }

    TEST_BEFORE_PUBLISH_HOOK.with(|h| {
        if let Some(ref hook) = *h.borrow() {
            hook();
        }
    });

    let link_res = {
        let injected = TEST_INJECT_LINK_FAILURE.with(|f| f.get());
        if let Some(kind) = injected {
            Err(match kind {
                std::io::ErrorKind::AlreadyExists => rustix::io::Errno::EXIST,
                std::io::ErrorKind::Unsupported => rustix::io::Errno::NOTSUP,
                _ => rustix::io::Errno::IO,
            })
        } else {
            linkat(
                &managed_jail.dir_file,
                &temp_filename,
                &managed_jail.dir_file,
                &target_filename,
                AtFlags::empty(),
            )
        }
    };

    let _ = unlinkat(&managed_jail.dir_file, &temp_filename, AtFlags::empty());

    match link_res {
        Ok(_) => {
            // Best-effort directory sync for crash durability
            let _ = managed_jail.dir_file.sync_all();

            // Postcondition verification through safe open handle
            let verify_fd = openat(
                &managed_jail.dir_file,
                &target_filename,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )
            .map_err(|e| {
                format!(
                    "Post-publication verification failed: could not open target {:?}: {}",
                    target_filename, e
                )
            })?;

            let mut verify_file = File::from(verify_fd);
            let final_bytes = read_bounded_file(&mut verify_file, MAX_ATTESTATION_ARTIFACT_BYTES)
                .map_err(|e| {
                    format!(
                        "Post-publication verification failed on target {:?}: {}",
                        target_filename, e
                    )
                })?;

            if final_bytes != canonical_bytes {
                return Err(format!(
                    "Post-publication verification failed: target {:?} bytes do not match canonical bytes",
                    target_filename
                ));
            }

            Ok((target_path, attestation_sha256))
        }
        Err(rustix::io::Errno::EXIST) => {
            // Final already exists. Open existing entry relative to SAME directory handle.
            // NOFOLLOW ensures we refuse symlinks/reparse points.
            let existing_fd = match openat(
                &managed_jail.dir_file,
                &target_filename,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            ) {
                Ok(fd) => fd,
                Err(rustix::io::Errno::LOOP) => {
                    return Err(format!(
                        "Attestation target {:?} is a symlink (refusing to overwrite)",
                        target_path
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "failed to open conflicting attestation {:?}: {}",
                        target_path, e
                    ));
                }
            };

            let mut existing_file = File::from(existing_fd);
            let existing_bytes =
                read_bounded_file(&mut existing_file, MAX_ATTESTATION_ARTIFACT_BYTES).map_err(
                    |e| {
                        format!(
                            "failed to read conflicting attestation {:?}: {}",
                            target_path, e
                        )
                    },
                )?;

            if existing_bytes == canonical_bytes {
                Ok((target_path, attestation_sha256))
            } else {
                Err(format!(
                    "Attestation collision: file {:?} appeared concurrently with conflicting contents",
                    target_path
                ))
            }
        }
        Err(e) => Err(format!(
            "Atomic hard-link publication failed for {:?} -> {:?}: {}. Refusing non-atomic fallback.",
            temp_filename, target_filename, e
        )),
    }
}

/// Extract content-addressed sha256 from filename if present (<run_id>.<sha256>.json).
pub fn extract_filename_digest(path: &Path) -> Option<String> {
    let file_stem = path.file_stem()?.to_str()?;
    let parts: Vec<&str> = file_stem.split('.').collect();
    if parts.len() == 2 && parts[1].len() == 64 && parts[1].chars().all(|c| c.is_ascii_hexdigit()) {
        Some(parts[1].to_ascii_lowercase())
    } else {
        None
    }
}

/// Load an attestation statement from a file path with integrity anchor check.
pub fn load_attestation_from_path(
    repo_root: &Path,
    file_path: &Path,
    expected_sha256: Option<&str>,
) -> Result<(VerificationAttestation, Vec<u8>, String), String> {
    let source = classify_attestation_source(repo_root, file_path, expected_sha256)?;

    let (resolved_path, expected_digest, is_managed) = match source {
        AttestationSource::Managed {
            path,
            filename_sha256,
        } => (path, filename_sha256, true),
        AttestationSource::External {
            path,
            expected_sha256,
        } => (path, expected_sha256, false),
    };

    let bytes = if is_managed {
        let managed_jail = ManagedAttestationDir::ensure(repo_root)?;
        let file_name = resolved_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid filename for {:?}", resolved_path))?;

        let fd = openat(
            &managed_jail.dir_file,
            file_name,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )
        .map_err(|e| {
            format!(
                "failed to open managed attestation file {:?} safely (symlinks rejected): {}",
                resolved_path, e
            )
        })?;

        let mut file = File::from(fd);
        read_bounded_file(&mut file, MAX_ATTESTATION_ARTIFACT_BYTES)?
    } else {
        let meta = fs::symlink_metadata(&resolved_path).map_err(|e| {
            format!(
                "attestation file {:?} metadata cannot be read: {}",
                resolved_path, e
            )
        })?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "attestation file {:?} is a symlink (symlinks are rejected)",
                resolved_path
            ));
        }
        if !meta.is_file() {
            return Err(format!(
                "attestation path {:?} is not a regular file",
                resolved_path
            ));
        }

        let mut file = File::open(&resolved_path)
            .map_err(|e| format!("failed to open attestation file {:?}: {}", resolved_path, e))?;
        read_bounded_file(&mut file, MAX_ATTESTATION_ARTIFACT_BYTES)?
    };

    let sha256 = sha256_bytes(&bytes);

    if expected_digest != sha256 {
        if is_managed {
            return Err(format!(
                "Filename digest mismatch for {:?}: embedded SHA {} != exact file hash {}",
                resolved_path, expected_digest, sha256
            ));
        } else {
            return Err(format!(
                "Expected digest mismatch for {:?}: expected SHA {} != exact file hash {}",
                resolved_path, expected_digest, sha256
            ));
        }
    }

    if let Some(exp_sha) = expected_sha256 {
        if exp_sha.to_ascii_lowercase() != sha256 {
            return Err(format!(
                "Expected digest mismatch for {:?}: expected SHA {} != exact file hash {}",
                resolved_path, exp_sha, sha256
            ));
        }
    }

    let statement: VerificationAttestation = serde_json::from_slice(&bytes).map_err(|e| {
        format!(
            "failed to parse in-toto attestation JSON from {:?}: {}",
            resolved_path, e
        )
    })?;

    if let Some(stem) = resolved_path.file_stem().and_then(|s| s.to_str()) {
        let parts: Vec<&str> = stem.split('.').collect();
        if parts.len() == 2 && parts[0] != statement.predicate.run.run_id {
            return Err(format!(
                "Run ID mismatch in filename {:?}: filename prefix {:?} != attested run_id {:?}",
                resolved_path, parts[0], statement.predicate.run.run_id
            ));
        }
    }

    Ok((statement, bytes, sha256))
}
