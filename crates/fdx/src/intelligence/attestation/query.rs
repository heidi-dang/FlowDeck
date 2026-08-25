//! Attestation inspection and query helpers.

use crate::intelligence::attestation::persist::{
    attestations_dir, load_attestation_document_from_path, AttestationDocument,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Summary of a discovered attestation file on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttestationSummary {
    pub predicate_type: String,
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
            if let Ok(loaded) = load_attestation_document_from_path(repo_root, &path, None) {
                let predicate_type = loaded.document.predicate_type().to_string();
                let (run_id, artifact_sha256, outcome, assurance) = match loaded.document {
                    AttestationDocument::V1(attestation) => (
                        attestation.predicate.run.run_id,
                        attestation.predicate.run.artifact_sha256,
                        attestation.predicate.result.outcome,
                        attestation.predicate.result.assurance,
                    ),
                    AttestationDocument::V2(attestation) => (
                        attestation.predicate.run.run_id,
                        attestation.predicate.run.artifact_sha256,
                        attestation.predicate.result.outcome,
                        attestation.predicate.result.assurance,
                    ),
                };
                summaries.push(AttestationSummary {
                    predicate_type,
                    run_id,
                    attestation_sha256: loaded.sha256,
                    artifact_sha256,
                    path,
                    outcome,
                    assurance,
                });
            }
        }
    }

    summaries.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    Ok(summaries)
}
