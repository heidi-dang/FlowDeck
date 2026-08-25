//! Milestone 12: policy-aware verification attestation Predicate v2.
//!
//! Predicate v2 preserves the in-toto Statement v1 envelope and binds an M11
//! historical policy application when, and only when, the persisted M7 run used
//! policy-added checks. It never consults today's active-policy authority to
//! rewrite a historical application.

use crate::intelligence::attestation::build::build_verification_attestation;
use crate::intelligence::attestation::canonical::{canonicalize_to_string, canonicalize_to_vec};
use crate::intelligence::attestation::model::{
    AttestationGenerator, AttestedCheck, AttestedExecution, AttestedPlan, AttestedRunIdentity,
    AttestedUncertainty, AttestedVerificationResult, InTotoStatement, RuntimeHistoryQualification,
    SourceContext, VerificationAttestation, FDX_VERIFICATION_PREDICATE_V1_TYPE,
    IN_TOTO_STATEMENT_V1_TYPE,
};
use crate::intelligence::attestation::verify::{verify_attestation, AttestationVerificationReport};
use crate::intelligence::policy::identity::{
    compute_application_digest, compute_snapshot_digest, compute_verification_plan_digest,
};
use crate::intelligence::policy::model::{
    LearnedPolicyTrigger, PolicyAction, PolicyApplication, PolicySnapshot, PolicyState,
    PromotedPolicy, POLICY_CONTRACT_VERSION,
};
use crate::intelligence::policy::overlay::{
    apply_additive_overlay, derive_impacted_scopes, load_persisted_overlay_templates,
};
use crate::intelligence::runtime::sha256_bytes;
use crate::intelligence::testplan::model::{SelectionReason, VerificationPlan};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

pub const FDX_VERIFICATION_PREDICATE_V2_TYPE: &str =
    "https://flowdeck.dev/attestation/vci/verification/v2";
pub const FDX_ATTESTATION_PREDICATE_V2_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppliedPolicyV2 {
    pub policy_id: String,
    pub policy_digest: String,
    pub template_digest: String,
    pub check_id: String,
    pub action: PolicyAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyApplicationContextV2 {
    pub base_plan_digest: String,
    pub effective_plan_digest: String,
    pub policy_snapshot_digest: String,
    pub policy_application_digest: String,
    pub added_check_ids: Vec<String>,
    pub applied_policy_ids: Vec<String>,
    pub applied_policy_digests: Vec<String>,
    pub applied_template_digests: Vec<String>,
    pub applied_policies: Vec<AppliedPolicyV2>,
    pub policy_contract_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationPredicateV2 {
    pub schema_version: u32,
    pub run: AttestedRunIdentity,
    pub plan: AttestedPlan,
    pub result: AttestedVerificationResult,
    pub executions: Vec<AttestedExecution>,
    pub checks: Vec<AttestedCheck>,
    pub uncertainty: Vec<AttestedUncertainty>,
    pub runtime_history: RuntimeHistoryQualification,
    pub source_context: SourceContext,
    pub generator: AttestationGenerator,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_context: Option<PolicyApplicationContextV2>,
}

pub type VerificationAttestationV2 = InTotoStatement<VerificationPredicateV2>;

#[derive(Debug, Clone)]
struct PersistedPolicyApplication {
    application: PolicyApplication,
    /// Exact SQL text retained from `added_check_ids_json`; it is separately
    /// checked against canonical JSON before its parsed value is trusted.
    added_check_ids_json: String,
    applied_at_ms: u64,
}

fn parse_policy_row(row: &rusqlite::Row<'_>) -> Result<PromotedPolicy, rusqlite::Error> {
    let template_digest = row
        .get::<_, Option<String>>(7)?
        .ok_or(rusqlite::Error::InvalidQuery)?;
    Ok(PromotedPolicy {
        policy_id: row.get(0)?,
        policy_contract_version: row.get::<_, i64>(1)? as u32,
        candidate_id: row.get(2)?,
        action: PolicyAction::parse(&row.get::<_, String>(3)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        trigger: LearnedPolicyTrigger {
            kind: row.get(4)?,
            scope: row.get(5)?,
        },
        check_id: row.get(6)?,
        template_digest,
        candidate_digest: row.get(8)?,
        promotion_policy_digest: row.get(9)?,
        promoted_policy_digest: row.get(10)?,
        state: PolicyState::parse(&row.get::<_, String>(11)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        promoted_at_ms: row.get::<_, i64>(12)? as u64,
        revoked_at_ms: row.get::<_, Option<i64>>(13)?.map(|value| value as u64),
        revoke_reason: row.get(14)?,
    })
}

fn historical_snapshot_at(conn: &Connection, applied_at_ms: u64) -> Result<PolicySnapshot, String> {
    let mut statement = conn
        .prepare(
            r#"SELECT policy_id, policy_contract_version, candidate_id, action, trigger_kind,
                      trigger_scope, check_id, template_digest, candidate_digest,
                      promotion_policy_digest, promoted_policy_digest, state, promoted_at_ms,
                      revoked_at_ms, revoke_reason
               FROM promoted_policies
               WHERE promoted_at_ms <= ?1
                 AND (revoked_at_ms IS NULL OR revoked_at_ms > ?1)
               ORDER BY policy_id ASC"#,
        )
        .map_err(|error| format!("failed to query historical policy snapshot: {error}"))?;
    let rows = statement
        .query_map(params![applied_at_ms as i64], parse_policy_row)
        .map_err(|error| format!("failed to query historical policy rows: {error}"))?
        .map(|row| row.map_err(|error| format!("invalid historical policy row: {error}")))
        .collect::<Result<Vec<_>, _>>()?;

    let mut policies = Vec::with_capacity(rows.len());
    for mut policy in rows {
        if policy.policy_contract_version != POLICY_CONTRACT_VERSION
            || policy.action != PolicyAction::AddCheck
            || policy.trigger.kind != "scope"
            || policy.policy_id.is_empty()
            || policy.check_id.is_empty()
            || policy.template_digest.is_empty()
            || policy.promoted_policy_digest.is_empty()
        {
            return Err(
                "historical policy snapshot contains unsupported policy authority".to_string(),
            );
        }
        // The application snapshot was captured while the row was active. A later revocation
        // cannot alter that historical identity, so normalize its historical lifecycle here.
        policy.state = PolicyState::Promoted;
        policy.revoked_at_ms = None;
        policy.revoke_reason = None;
        policies.push(policy);
    }
    let mut snapshot = PolicySnapshot {
        policies,
        snapshot_digest: String::new(),
    };
    snapshot.snapshot_digest = compute_snapshot_digest(&snapshot)?;
    Ok(snapshot)
}

fn application_for_effective_plan(
    conn: &Connection,
    effective_plan_digest: &str,
) -> Result<Option<PersistedPolicyApplication>, String> {
    let mut statement = conn
        .prepare(
            r#"SELECT application_id, base_plan_digest, policy_snapshot_digest,
                      effective_plan_digest, added_check_ids_json, application_digest,
                      applied_at_ms
               FROM policy_applications
               WHERE effective_plan_digest = ?1
               ORDER BY application_id ASC"#,
        )
        .map_err(|error| format!("failed to query policy application: {error}"))?;
    let rows = statement
        .query_map(params![effective_plan_digest], |row| {
            let added_json: String = row.get(4)?;
            let added_check_ids: Vec<String> =
                serde_json::from_str(&added_json).map_err(|_| rusqlite::Error::InvalidQuery)?;
            Ok(PersistedPolicyApplication {
                application: PolicyApplication {
                    application_id: row.get(0)?,
                    base_plan_digest: row.get(1)?,
                    policy_snapshot_digest: row.get(2)?,
                    effective_plan_digest: row.get(3)?,
                    added_check_ids,
                    application_digest: row.get(5)?,
                },
                added_check_ids_json: added_json,
                applied_at_ms: row.get::<_, i64>(6)? as u64,
            })
        })
        .map_err(|error| format!("failed to map policy application: {error}"))?
        .map(|row| row.map_err(|error| format!("invalid policy application row: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    match rows.len() {
        0 => Ok(None),
        1 => Ok(rows.into_iter().next()),
        _ => Err(
            "multiple historical policy applications match one effective plan digest".to_string(),
        ),
    }
}

fn load_run_plan(
    repo_root: &Path,
    run_id: &str,
) -> Result<crate::intelligence::verify::model::VerificationRun, String> {
    let artifact_path = crate::intelligence::verify::persist::run_artifact_path(repo_root, run_id);
    let bytes = fs::read(&artifact_path).map_err(|error| {
        format!("failed to read verification artifact for v2 policy binding: {error}")
    })?;
    let run: crate::intelligence::verify::model::VerificationRun = serde_json::from_slice(&bytes)
        .map_err(|error| {
        format!("failed to parse verification artifact for v2 policy binding: {error}")
    })?;
    if run.run_id != run_id {
        return Err(
            "verification artifact run identity mismatch during v2 policy binding".to_string(),
        );
    }
    Ok(run)
}

fn policy_added_check_ids(plan: &VerificationPlan) -> BTreeSet<String> {
    plan.selected_checks
        .iter()
        .filter(|check| {
            check.selection == SelectionReason::PolicyWidening
                && check.widening_reason.as_deref() == Some("learned_policy_add_check")
        })
        .map(|check| check.check_id.clone())
        .collect()
}

fn policy_context_for_plan(
    repo_root: &Path,
    conn: &Connection,
    run_id: &str,
) -> Result<Option<PolicyApplicationContextV2>, String> {
    let run = load_run_plan(repo_root, run_id)?;
    let run_plan = run.plan;
    let effective_plan_digest = compute_verification_plan_digest(&run_plan)?;
    let policy_check_ids = policy_added_check_ids(&run_plan);
    let stored = application_for_effective_plan(conn, &effective_plan_digest)?;

    if policy_check_ids.is_empty() {
        return Ok(None);
    }
    let stored = stored.ok_or_else(|| {
        "verification run contains learned-policy checks but no matching persisted policy application"
            .to_string()
    })?;
    let canonical_added_check_ids_json =
        canonicalize_to_string(&stored.application.added_check_ids)?;
    // M11 computes the digest before assigning the derived `policyapp_<digest>` identifier.
    // Restore that exact digest input rather than hashing a persisted row containing its ID.
    let mut application_digest_input = stored.application.clone();
    application_digest_input.application_id.clear();
    application_digest_input.application_digest.clear();
    if compute_application_digest(&application_digest_input)?
        != stored.application.application_digest
        || stored.application.application_id
            != format!("policyapp_{}", stored.application.application_digest)
        || stored.added_check_ids_json != canonical_added_check_ids_json
    {
        return Err("persisted policy application has an invalid canonical identity".to_string());
    }

    let base_plan = crate::intelligence::testplan::planner::plan_verification(
        repo_root,
        run.base.as_deref(),
        run.head.as_deref(),
        None,
    )
    .map_err(|error| format!("failed to reconstruct frozen M6 base plan for v2: {error}"))?;
    let snapshot = historical_snapshot_at(conn, stored.applied_at_ms)?;
    if snapshot.snapshot_digest != stored.application.policy_snapshot_digest {
        return Err(
            "historical policy snapshot digest does not match persisted application".to_string(),
        );
    }
    let templates = load_persisted_overlay_templates(conn, &snapshot)?;
    let impacted = derive_impacted_scopes(repo_root, &base_plan);
    let effective = apply_additive_overlay(&base_plan, &snapshot, &templates, &impacted)?;

    if effective.application != stored.application
        || effective.plan != run_plan
        || effective.application.effective_plan_digest != effective_plan_digest
    {
        return Err(
            "persisted policy application does not exactly reproduce verification run plan"
                .to_string(),
        );
    }
    let base_ids = base_plan
        .selected_checks
        .iter()
        .map(|check| check.check_id.clone())
        .collect::<BTreeSet<_>>();
    let effective_ids = run_plan
        .selected_checks
        .iter()
        .map(|check| check.check_id.clone())
        .collect::<BTreeSet<_>>();
    if !base_ids.is_subset(&effective_ids) {
        return Err("policy-aware attestation rejected non-additive effective plan".to_string());
    }
    let stored_added = stored
        .application
        .added_check_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if stored_added != policy_check_ids
        || stored_added != effective.added_check_ids.iter().cloned().collect()
    {
        return Err(
            "policy application additions do not match learned-policy checks in verification run"
                .to_string(),
        );
    }

    let applied_policies = snapshot
        .policies
        .iter()
        .filter(|policy| {
            impacted.contains(&policy.trigger.scope)
                && !base_ids.contains(&policy.check_id)
                && stored_added.contains(&policy.check_id)
        })
        .map(|policy| AppliedPolicyV2 {
            policy_id: policy.policy_id.clone(),
            policy_digest: policy.promoted_policy_digest.clone(),
            template_digest: policy.template_digest.clone(),
            check_id: policy.check_id.clone(),
            action: policy.action.clone(),
        })
        .collect::<Vec<_>>();
    if applied_policies.is_empty()
        || applied_policies
            .iter()
            .any(|policy| policy.action != PolicyAction::AddCheck)
    {
        return Err(
            "policy application has no exact active ADD_CHECK policy provenance".to_string(),
        );
    }
    let applied_policy_ids = applied_policies
        .iter()
        .map(|policy| policy.policy_id.clone())
        .collect::<Vec<_>>();
    let applied_policy_digests = applied_policies
        .iter()
        .map(|policy| policy.policy_digest.clone())
        .collect::<Vec<_>>();
    let applied_template_digests = applied_policies
        .iter()
        .map(|policy| policy.template_digest.clone())
        .collect::<Vec<_>>();

    Ok(Some(PolicyApplicationContextV2 {
        base_plan_digest: stored.application.base_plan_digest,
        effective_plan_digest: stored.application.effective_plan_digest,
        policy_snapshot_digest: stored.application.policy_snapshot_digest,
        policy_application_digest: stored.application.application_digest,
        added_check_ids: stored.application.added_check_ids,
        applied_policy_ids,
        applied_policy_digests,
        applied_template_digests,
        applied_policies,
        policy_contract_version: POLICY_CONTRACT_VERSION,
    }))
}

/// Build a Predicate v2 statement. The frozen v1 projection is first constructed unchanged;
/// only an independently proven M11 historical application is appended as optional context.
pub fn build_verification_attestation_v2(
    repo_root: &Path,
    run_id: &str,
    conn: &Connection,
) -> Result<VerificationAttestationV2, String> {
    let v1 = build_verification_attestation(repo_root, run_id, conn)?;
    let policy_context = policy_context_for_plan(repo_root, conn, run_id)?;
    let predicate = VerificationPredicateV2 {
        schema_version: FDX_ATTESTATION_PREDICATE_V2_VERSION,
        run: v1.predicate.run,
        plan: v1.predicate.plan,
        result: v1.predicate.result,
        executions: v1.predicate.executions,
        checks: v1.predicate.checks,
        uncertainty: v1.predicate.uncertainty,
        runtime_history: v1.predicate.runtime_history,
        source_context: v1.predicate.source_context,
        generator: v1.predicate.generator,
        policy_context,
    };
    Ok(InTotoStatement {
        statement_type: IN_TOTO_STATEMENT_V1_TYPE.to_string(),
        subject: v1.subject,
        predicate_type: FDX_VERIFICATION_PREDICATE_V2_TYPE.to_string(),
        predicate,
    })
}

/// Verify a Predicate v2 attestation. V1 evidence verification is reused for the shared frozen
/// projection, then v2 context is regenerated from historical application evidence and compared
/// byte-for-byte as a semantic value.
pub fn verify_attestation_v2(
    repo_root: &Path,
    attestation: &VerificationAttestationV2,
    raw_bytes: Option<&[u8]>,
    expected_sha256: Option<&str>,
    conn: &Connection,
) -> Result<AttestationVerificationReport, String> {
    if attestation.statement_type != IN_TOTO_STATEMENT_V1_TYPE
        || attestation.predicate_type != FDX_VERIFICATION_PREDICATE_V2_TYPE
        || attestation.predicate.schema_version != FDX_ATTESTATION_PREDICATE_V2_VERSION
        || attestation.subject.len() != 1
    {
        return Err("unsupported or malformed Predicate v2 attestation envelope".to_string());
    }
    let canonical = canonicalize_to_vec(attestation)?;
    let digest = sha256_bytes(&canonical);
    if let Some(raw) = raw_bytes {
        if raw != canonical {
            return Err("non-canonical raw Predicate v2 bytes rejected".to_string());
        }
    }
    if let Some(expected) = expected_sha256 {
        if digest != expected.to_ascii_lowercase() {
            return Err(
                "Predicate v2 attestation digest does not match integrity anchor".to_string(),
            );
        }
    }

    let v1 = VerificationAttestation {
        statement_type: IN_TOTO_STATEMENT_V1_TYPE.to_string(),
        subject: attestation.subject.clone(),
        predicate_type: FDX_VERIFICATION_PREDICATE_V1_TYPE.to_string(),
        predicate: crate::intelligence::attestation::model::VerificationPredicateV1 {
            schema_version:
                crate::intelligence::attestation::model::FDX_ATTESTATION_PREDICATE_VERSION,
            run: attestation.predicate.run.clone(),
            plan: attestation.predicate.plan.clone(),
            result: attestation.predicate.result.clone(),
            executions: attestation.predicate.executions.clone(),
            checks: attestation.predicate.checks.clone(),
            uncertainty: attestation.predicate.uncertainty.clone(),
            runtime_history: attestation.predicate.runtime_history.clone(),
            source_context: attestation.predicate.source_context.clone(),
            generator: attestation.predicate.generator.clone(),
        },
    };
    let mut report = verify_attestation(repo_root, &v1, None, None, conn)?;
    let expected =
        build_verification_attestation_v2(repo_root, &attestation.predicate.run.run_id, conn)?;
    if attestation != &expected {
        return Err("Predicate v2 policy or verification provenance does not match authoritative historical evidence".to_string());
    }
    report.attestation_sha256 = digest;
    Ok(report)
}
