//! Atomic, contained, and path-safe persistence for verification attestations.

use crate::intelligence::attestation::canonical::canonicalize_to_vec;
use crate::intelligence::attestation::model::VerificationAttestation;
use crate::intelligence::runtime::sha256_bytes;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum permitted size for an attestation artifact file (16 MiB).
pub const MAX_ATTESTATION_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;

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

/// Validated canonical managed attestation directory context.
#[derive(Debug, Clone)]
pub struct ManagedAttestationDir {
    pub repo_root: PathBuf,
    pub fdx_dir: PathBuf,
    pub attestations_dir: PathBuf,
}

impl ManagedAttestationDir {
    /// Validate that repo_root, .fdx, and .fdx/attestations form a strict, non-symlink containment jail.
    pub fn ensure(repo_root: &Path) -> Result<Self, String> {
        let canonical_repo = repo_root
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize repository root {:?}: {}", repo_root, e))?;

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

        Ok(Self {
            repo_root: canonical_repo,
            fdx_dir,
            attestations_dir,
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

    if meta.len() > MAX_ATTESTATION_ARTIFACT_BYTES {
        return Err(format!(
            "attestation file {:?} exceeds maximum allowed size ({} bytes > {} max)",
            resolved_path,
            meta.len(),
            MAX_ATTESTATION_ARTIFACT_BYTES
        ));
    }

    let is_managed = (|| -> Result<Option<String>, String> {
        let managed_jail = match ManagedAttestationDir::ensure(repo_root) {
            Ok(j) => j,
            Err(_) => return Ok(None),
        };
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

        let parent = match canonical_file.parent() {
            Some(p) => p,
            None => return Ok(None),
        };

        if parent == canonical_att_dir {
            if let Some(fn_sha) = extract_filename_digest(&resolved_path) {
                return Ok(Some(fn_sha));
            }
        }
        Ok(None)
    })();

    let is_managed_res = is_managed.unwrap_or(None);
    if let Some(fn_sha) = is_managed_res {
        Ok(AttestationSource::Managed {
            path: resolved_path,
            filename_sha256: fn_sha,
        })
    } else if let Some(exp_sha) = expected_sha256 {
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
    let target_path = dir.join(format!("{}.{}.json", run_id, attestation_sha256));

    if target_path.exists() || target_path.is_symlink() {
        let meta = fs::symlink_metadata(&target_path).map_err(|e| {
            format!(
                "failed to read metadata of existing attestation {:?}: {}",
                target_path, e
            )
        })?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Attestation target {:?} is a symlink (refusing to overwrite)",
                target_path
            ));
        }
        let existing_bytes = fs::read(&target_path).map_err(|e| {
            format!(
                "failed to read existing attestation {:?}: {}",
                target_path, e
            )
        })?;
        if existing_bytes == canonical_bytes {
            return Ok((target_path, attestation_sha256));
        } else {
            return Err(format!(
                "Attestation collision: file {:?} already exists with conflicting contents",
                target_path
            ));
        }
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let prefix = if attestation_sha256.len() >= 8 {
        &attestation_sha256[..8]
    } else {
        &attestation_sha256
    };
    let temp_path = dir.join(format!(".{}.{}.tmp-{}", run_id, prefix, nonce));

    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    let write_res = (|| -> std::io::Result<()> {
        let mut file = options.open(&temp_path)?;
        file.write_all(&canonical_bytes)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "failed to write temporary attestation {:?}: {}",
            temp_path, e
        ));
    }

    let link_res = fs::hard_link(&temp_path, &target_path);
    let _ = fs::remove_file(&temp_path);

    match link_res {
        Ok(_) => {
            // Best-effort directory sync for crash durability
            if let Ok(d) = File::open(&dir) {
                let _ = d.sync_all();
            }
            Ok((target_path, attestation_sha256))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing_bytes = fs::read(&target_path).map_err(|re| {
                format!(
                    "failed to read conflicting attestation {:?}: {}",
                    target_path, re
                )
            })?;
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
            temp_path, target_path, e
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

    let bytes = fs::read(&resolved_path)
        .map_err(|e| format!("failed to read attestation file {:?}: {}", resolved_path, e))?;

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
