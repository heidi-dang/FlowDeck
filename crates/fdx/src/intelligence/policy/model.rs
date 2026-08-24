use crate::intelligence::testplan::model::{PlannedCheck, VerificationPlan};
use crate::protocol::AssuranceLevel;
use serde::{Deserialize, Serialize};

pub const POLICY_CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyAction {
    AddCheck,
}

impl PolicyAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AddCheck => "add_check",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "add_check" => Ok(Self::AddCheck),
            _ => Err(format!("unsupported M11 policy action '{value}'")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyState {
    Candidate,
    Eligible,
    Promoted,
    Rejected,
    Revoked,
    Superseded,
}

impl PolicyState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Candidate => "candidate",
            Self::Eligible => "eligible",
            Self::Promoted => "promoted",
            Self::Rejected => "rejected",
            Self::Revoked => "revoked",
            Self::Superseded => "superseded",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "candidate" => Ok(Self::Candidate),
            "eligible" => Ok(Self::Eligible),
            "promoted" => Ok(Self::Promoted),
            "rejected" => Ok(Self::Rejected),
            "revoked" => Ok(Self::Revoked),
            "superseded" => Ok(Self::Superseded),
            _ => Err(format!("unknown M11 policy state '{value}'")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LearnedPolicyTrigger {
    pub kind: String,
    pub scope: String,
}

impl LearnedPolicyTrigger {
    pub fn scope(scope: String) -> Result<Self, String> {
        if scope.trim().is_empty()
            || scope.contains("..")
            || scope.starts_with('/')
            || scope.contains('\\')
        {
            return Err("M11 trigger scope must be a stable non-path scope identifier".to_string());
        }
        Ok(Self {
            kind: "scope".to_string(),
            scope,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromotionPolicy {
    pub min_observed_misses: u32,
    pub min_distinct_source_artifacts: u32,
    pub min_distinct_change_fingerprints: u32,
    pub max_added_checks_per_trigger: u32,
    pub max_estimated_added_runtime_ms: u64,
    pub lookback_limit: u32,
    pub auto_promote_additive: bool,
}

impl Default for PromotionPolicy {
    fn default() -> Self {
        Self {
            min_observed_misses: 2,
            min_distinct_source_artifacts: 2,
            min_distinct_change_fingerprints: 2,
            max_added_checks_per_trigger: 1,
            max_estimated_added_runtime_ms: 60_000,
            lookback_limit: 1_000,
            auto_promote_additive: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyCandidate {
    pub candidate_id: String,
    pub candidate_contract_version: u32,
    pub trigger: LearnedPolicyTrigger,
    pub check_id: String,
    pub candidate_digest: String,
    pub promotion_policy_digest: String,
    pub support_count: u32,
    pub distinct_source_artifact_count: u32,
    pub distinct_change_fingerprint_count: u32,
    pub estimated_added_runtime_ms: u64,
    pub state: PolicyState,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub promoted_policy_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromotedPolicy {
    pub policy_id: String,
    pub policy_contract_version: u32,
    pub candidate_id: String,
    pub action: PolicyAction,
    pub trigger: LearnedPolicyTrigger,
    pub check_id: String,
    pub candidate_digest: String,
    pub promotion_policy_digest: String,
    pub promoted_policy_digest: String,
    pub state: PolicyState,
    pub promoted_at_ms: u64,
    pub revoked_at_ms: Option<u64>,
    pub revoke_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicySnapshot {
    pub policies: Vec<PromotedPolicy>,
    pub snapshot_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyApplication {
    pub application_id: String,
    pub base_plan_digest: String,
    pub policy_snapshot_digest: String,
    pub effective_plan_digest: String,
    pub added_check_ids: Vec<String>,
    pub application_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectiveVerificationPlan {
    pub plan: VerificationPlan,
    pub application: PolicyApplication,
    pub base_assurance: AssuranceLevel,
    pub base_check_ids: Vec<String>,
    pub added_check_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyCheckTemplate {
    pub check: PlannedCheck,
}
