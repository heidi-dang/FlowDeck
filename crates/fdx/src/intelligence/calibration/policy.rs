//! Deterministic policy hashing and calibration run identity.

use crate::intelligence::attestation::canonical::compute_canonical_sha256;
use crate::intelligence::calibration::model::CalibrationPolicy;
use crate::intelligence::runtime::sha256_bytes;

/// Compute deterministic SHA256 hex digest of a CalibrationPolicy using RFC 8785 canonical JSON.
pub fn compute_policy_digest(policy: &CalibrationPolicy) -> Result<String, String> {
    compute_canonical_sha256(policy)
}

/// Generate deterministic, collision-safe calibration run identifier binding source run, plan, policy, and schema.
pub fn generate_calibration_id(
    source_run_id: &str,
    candidate_plan_digest: &str,
    policy_digest: &str,
    schema_version: u32,
) -> String {
    let raw = format!(
        "{}:{}:{}:{}",
        source_run_id, candidate_plan_digest, policy_digest, schema_version
    );
    format!("cal_{}", sha256_bytes(raw.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intelligence::calibration::model::ReferenceScope;

    #[test]
    fn test_policy_digest_determinism_and_sensitivity() {
        let p1 = CalibrationPolicy::default();
        let p2 = CalibrationPolicy::default();
        let d1 = compute_policy_digest(&p1).unwrap();
        let d2 = compute_policy_digest(&p2).unwrap();
        assert_eq!(d1, d2);

        let p3 = CalibrationPolicy {
            max_shadow_checks: 100,
            ..Default::default()
        };
        let d3 = compute_policy_digest(&p3).unwrap();
        assert_ne!(d1, d3);

        let p4 = CalibrationPolicy {
            scope: ReferenceScope::Workspace,
            ..Default::default()
        };
        let d4 = compute_policy_digest(&p4).unwrap();
        assert_ne!(d1, d4);
    }
}
