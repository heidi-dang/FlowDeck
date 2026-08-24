use crate::intelligence::attestation::canonical::compute_canonical_sha256;
use crate::intelligence::policy::model::{
    LearnedPolicyTrigger, PolicyApplication, PolicyCandidate, PolicySnapshot, PromotionPolicy,
    POLICY_CONTRACT_VERSION,
};
use crate::intelligence::runtime::sha256_bytes;
use crate::intelligence::testplan::model::{PlannedCheck, VerificationPlan};
use serde::Serialize;

pub fn compute_promotion_policy_digest(policy: &PromotionPolicy) -> Result<String, String> {
    compute_canonical_sha256(policy)
}

pub fn generate_candidate_id(
    trigger: &LearnedPolicyTrigger,
    check_id: &str,
    promotion_policy_digest: &str,
) -> String {
    let raw = format!(
        "{}:{}:{}:{}:{}",
        POLICY_CONTRACT_VERSION, trigger.kind, trigger.scope, check_id, promotion_policy_digest
    );
    format!("polcand_{}", sha256_bytes(raw.as_bytes()))
}

#[derive(Serialize)]
struct CandidateDigestInput<'a> {
    candidate_contract_version: u32,
    trigger: &'a LearnedPolicyTrigger,
    check_id: &'a str,
    promotion_policy_digest: &'a str,
    support_count: u32,
    distinct_source_artifact_count: u32,
    distinct_change_fingerprint_count: u32,
    estimated_added_runtime_ms: u64,
    state: &'a crate::intelligence::policy::model::PolicyState,
}

pub fn compute_candidate_digest(candidate: &PolicyCandidate) -> Result<String, String> {
    compute_canonical_sha256(&CandidateDigestInput {
        candidate_contract_version: candidate.candidate_contract_version,
        trigger: &candidate.trigger,
        check_id: &candidate.check_id,
        promotion_policy_digest: &candidate.promotion_policy_digest,
        support_count: candidate.support_count,
        distinct_source_artifact_count: candidate.distinct_source_artifact_count,
        distinct_change_fingerprint_count: candidate.distinct_change_fingerprint_count,
        estimated_added_runtime_ms: candidate.estimated_added_runtime_ms,
        state: &candidate.state,
    })
}

pub fn compute_template_digest(template: &PlannedCheck) -> Result<String, String> {
    compute_canonical_sha256(template)
}

pub fn compute_verification_plan_digest(plan: &VerificationPlan) -> Result<String, String> {
    compute_canonical_sha256(plan)
}

pub fn compute_snapshot_digest(snapshot: &PolicySnapshot) -> Result<String, String> {
    compute_canonical_sha256(snapshot)
}

pub fn compute_application_digest(application: &PolicyApplication) -> Result<String, String> {
    compute_canonical_sha256(application)
}
