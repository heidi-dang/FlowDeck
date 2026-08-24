//! Deterministic cryptographic hashing for M8 runtime artifacts and verification plans.

use crate::intelligence::testplan::model::VerificationPlan;
use sha2::{Digest, Sha256};

/// Compute SHA256 hex digest over raw bytes.
pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Compute deterministic SHA256 hex digest over a VerificationPlan.
pub fn compute_plan_digest(plan: &VerificationPlan) -> Result<String, String> {
    let json_bytes = serde_json::to_vec(plan)
        .map_err(|e| format!("cannot serialize verification plan: {}", e))?;
    Ok(sha256_bytes(&json_bytes))
}

/// Compute deterministic SHA256 hex digest over argv vector.
pub fn compute_argv_digest(argv: &[String]) -> String {
    let joined = argv.join("\0");
    sha256_bytes(joined.as_bytes())
}
