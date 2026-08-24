//! Atomic and path-safe persistence for verification attestations.

use crate::intelligence::attestation::canonical::canonicalize_to_vec;
use crate::intelligence::attestation::model::VerificationAttestation;
use crate::intelligence::runtime::sha256_bytes;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Ensure that the .fdx/attestations directory is safely contained inside the repository jail.
fn ensure_attestations_dir_contained(repo_root: &Path) -> Result<PathBuf, String> {
    let fdx_dir = repo_root.join(".fdx");
    if !fdx_dir.exists() {
        fs::create_dir_all(&fdx_dir)
            .map_err(|e| format!("failed to create .fdx directory {:?}: {}", fdx_dir, e))?;
    }

    let dir = attestations_dir(repo_root);

    if dir.is_symlink() {
        let canonical_repo = repo_root
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize repository root {:?}: {}", repo_root, e))?;
        let canonical_dir = dir.canonicalize().map_err(|e| {
            format!(
                "attestation directory symlink target invalid {:?}: {}",
                dir, e
            )
        })?;
        if !canonical_dir.starts_with(&canonical_repo) {
            return Err(format!(
                "attestations directory symlink points outside repository jail: {:?}",
                dir
            ));
        }
    }

    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create attestations directory {:?}: {}", dir, e))?;
    }

    Ok(dir)
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

    let dir = ensure_attestations_dir_contained(repo_root)?;
    let target_path = attestation_file_path(repo_root, run_id, &attestation_sha256);

    if target_path.exists() {
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

    let write_res = (|| -> std::io::Result<()> {
        let mut file = File::create(&temp_path)?;
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
        Ok(_) => Ok((target_path, attestation_sha256)),
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
        Err(_) => {
            if target_path.exists() {
                let existing_bytes = fs::read(&target_path).map_err(|re| {
                    format!(
                        "failed to read existing attestation {:?}: {}",
                        target_path, re
                    )
                })?;
                if existing_bytes == canonical_bytes {
                    Ok((target_path, attestation_sha256))
                } else {
                    Err(format!(
                        "Attestation collision: file {:?} already exists with conflicting contents",
                        target_path
                    ))
                }
            } else {
                let mut options = fs::OpenOptions::new();
                options.write(true).create_new(true);
                match options.open(&target_path) {
                    Ok(mut file) => {
                        file.write_all(&canonical_bytes)
                            .map_err(|we| we.to_string())?;
                        file.sync_all().map_err(|se| se.to_string())?;
                        Ok((target_path, attestation_sha256))
                    }
                    Err(oe) if oe.kind() == std::io::ErrorKind::AlreadyExists => {
                        let existing_bytes = fs::read(&target_path).map_err(|re| {
                            format!(
                                "failed to read existing attestation {:?}: {}",
                                target_path, re
                            )
                        })?;
                        if existing_bytes == canonical_bytes {
                            Ok((target_path, attestation_sha256))
                        } else {
                            Err(format!(
                                "Attestation collision: file {:?} exists with conflicting contents",
                                target_path
                            ))
                        }
                    }
                    Err(oe) => Err(format!(
                        "failed to write attestation to {:?}: {}",
                        target_path, oe
                    )),
                }
            }
        }
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
    let resolved_path = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        repo_root.join(file_path)
    };

    if !resolved_path.exists() {
        return Err(format!(
            "attestation file does not exist: {:?}",
            resolved_path
        ));
    }

    let bytes = fs::read(&resolved_path)
        .map_err(|e| format!("failed to read attestation file {:?}: {}", resolved_path, e))?;

    let sha256 = sha256_bytes(&bytes);

    let filename_sha = extract_filename_digest(&resolved_path);
    if let Some(ref fn_sha) = filename_sha {
        if fn_sha != &sha256 {
            return Err(format!(
                "Filename digest mismatch for {:?}: embedded SHA {} != exact file hash {}",
                resolved_path, fn_sha, sha256
            ));
        }
        if let Some(exp_sha) = expected_sha256 {
            if exp_sha != sha256 {
                return Err(format!(
                    "Expected digest mismatch for {:?}: expected SHA {} != exact file hash {}",
                    resolved_path, exp_sha, sha256
                ));
            }
        }
    } else if let Some(exp_sha) = expected_sha256 {
        if exp_sha != sha256 {
            return Err(format!(
                "Expected digest mismatch for {:?}: expected SHA {} != exact file hash {}",
                resolved_path, exp_sha, sha256
            ));
        }
    } else {
        return Err(format!(
            "External attestation file {:?} is not content-addressed (<run_id>.<sha256>.json). Verification requires --expected-sha256 <sha256> integrity anchor.",
            resolved_path
        ));
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
                "Filename run ID mismatch: filename {} != statement run_id {}",
                parts[0], statement.predicate.run.run_id
            ));
        }
    }

    Ok((statement, bytes, sha256))
}
