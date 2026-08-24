//! Attestation inspection and query helpers.

use crate::intelligence::attestation::persist::{attestations_dir, load_attestation_from_path};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Summary of a discovered attestation file on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttestationSummary {
    pub run_id: String,
    pub attestation_sha256: String,
    pub artifact_sha256: String,
    pub path: PathBuf,
    pub outcome: crate::intelligence::verify::model::VerificationOutcome,
    pub assurance: crate::protocol::AssuranceLevel,
}

/// List all attestations in `.fdx/attestations/`.
pub fn list_attestations(repo_root: &Path) -> Result<Vec<AttestationSummary>, String> {
    let dir = attestations_dir(repo_root);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut summaries = Vec::new();
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("failed to read attestations directory {:?}: {}", dir, e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok((attestation, _bytes, sha)) =
                load_attestation_from_path(repo_root, &path, None)
            {
                summaries.push(AttestationSummary {
                    run_id: attestation.predicate.run.run_id.clone(),
                    attestation_sha256: sha,
                    artifact_sha256: attestation.predicate.run.artifact_sha256.clone(),
                    path,
                    outcome: attestation.predicate.result.outcome,
                    assurance: attestation.predicate.result.assurance,
                });
            }
        }
    }

    summaries.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    Ok(summaries)
}
