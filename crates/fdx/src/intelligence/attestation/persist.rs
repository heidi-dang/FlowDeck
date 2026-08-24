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

/// Persist an attestation artifact atomically to `.fdx/attestations/<run_id>.<attestation_sha256>.json`.
pub fn persist_attestation(
    repo_root: &Path,
    attestation: &VerificationAttestation,
) -> Result<(PathBuf, String), String> {
    let run_id = &attestation.predicate.run.run_id;
    validate_identifier(run_id)?;

    let canonical_bytes = canonicalize_to_vec(attestation)?;
    let attestation_sha256 = sha256_bytes(&canonical_bytes);

    let dir = attestations_dir(repo_root);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create attestations directory {:?}: {}", dir, e))?;

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

    if let Err(e) = fs::rename(&temp_path, &target_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!(
            "failed to atomically rename {:?} to {:?}: {}",
            temp_path, target_path, e
        ));
    }

    Ok((target_path, attestation_sha256))
}

/// Load an attestation statement from a file path with traversal containment check.
pub fn load_attestation_from_path(
    repo_root: &Path,
    file_path: &Path,
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

    let statement: VerificationAttestation = serde_json::from_slice(&bytes).map_err(|e| {
        format!(
            "failed to parse in-toto attestation JSON from {:?}: {}",
            resolved_path, e
        )
    })?;

    Ok((statement, bytes, sha256))
}
