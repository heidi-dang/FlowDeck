use crate::intelligence::policy::identity::{compute_application_digest, compute_snapshot_digest};
use crate::intelligence::policy::model::{
    EffectiveVerificationPlan, PolicyAction, PolicyApplication, PolicySnapshot, PolicyState,
    PromotedPolicy,
};
use crate::intelligence::runtime::sha256_bytes;
use crate::intelligence::testplan::model::{PlannedCheck, VerificationPlan};
use rusqlite::{params, Connection};
use std::collections::{BTreeMap, BTreeSet};

pub fn active_policy_snapshot(conn: &Connection) -> Result<PolicySnapshot, String> {
    let mut statement = conn
        .prepare(
            r#"SELECT policy_id, policy_contract_version, candidate_id, action, trigger_kind,
                       trigger_scope, check_id, candidate_digest, promotion_policy_digest,
                       promoted_policy_digest, state, promoted_at_ms, revoked_at_ms, revoke_reason
                FROM promoted_policies WHERE state = 'promoted'
                ORDER BY policy_id ASC"#,
        )
        .map_err(|error| format!("failed to prepare active policy snapshot: {error}"))?;
    let policies = statement
        .query_map([], |row| {
            Ok(PromotedPolicy {
                policy_id: row.get(0)?,
                policy_contract_version: row.get::<_, i64>(1)? as u32,
                candidate_id: row.get(2)?,
                action: PolicyAction::parse(&row.get::<_, String>(3)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                trigger: crate::intelligence::policy::model::LearnedPolicyTrigger {
                    kind: row.get(4)?,
                    scope: row.get(5)?,
                },
                check_id: row.get(6)?,
                candidate_digest: row.get(7)?,
                promotion_policy_digest: row.get(8)?,
                promoted_policy_digest: row.get(9)?,
                state: PolicyState::parse(&row.get::<_, String>(10)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                promoted_at_ms: row.get::<_, i64>(11)? as u64,
                revoked_at_ms: row.get::<_, Option<i64>>(12)?.map(|value| value as u64),
                revoke_reason: row.get(13)?,
            })
        })
        .map_err(|error| format!("failed to query active policy snapshot: {error}"))?
        .map(|row| row.map_err(|error| format!("invalid active policy row: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    for policy in &policies {
        if policy.state != PolicyState::Promoted || policy.action != PolicyAction::AddCheck {
            return Err(
                "active policy snapshot contains unsupported or non-promoted policy".to_string(),
            );
        }
        if policy.promoted_policy_digest.is_empty() || policy.check_id.is_empty() {
            return Err("active policy snapshot contains corrupt policy identity".to_string());
        }
    }
    let mut snapshot = PolicySnapshot {
        policies,
        snapshot_digest: String::new(),
    };
    snapshot.snapshot_digest = compute_snapshot_digest(&snapshot)?;
    Ok(snapshot)
}

/// Overlay active policy additions over a cloned M6 plan. The caller supplies only check
/// templates established by qualified M10 evidence; policies without a template fail closed.
pub fn apply_additive_overlay(
    base_plan: &VerificationPlan,
    snapshot: &PolicySnapshot,
    templates: &BTreeMap<String, PlannedCheck>,
    impacted_scopes: &BTreeSet<String>,
) -> Result<EffectiveVerificationPlan, String> {
    let base_check_ids = base_plan
        .selected_checks
        .iter()
        .map(|check| check.check_id.clone())
        .collect::<BTreeSet<_>>();
    let mut plan = base_plan.clone();
    let mut additions = BTreeMap::new();
    for policy in &snapshot.policies {
        if policy.action != PolicyAction::AddCheck || policy.state != PolicyState::Promoted {
            return Err(
                "M11 refuses non-additive or non-promoted policy during overlay".to_string(),
            );
        }
        if policy.trigger.kind != "scope" {
            return Err("M11 refuses unsupported policy trigger during overlay".to_string());
        }
        if !impacted_scopes.contains(&policy.trigger.scope)
            || base_check_ids.contains(&policy.check_id)
        {
            continue;
        }
        let template = templates.get(&policy.check_id).ok_or_else(|| {
            format!(
                "active policy '{}' has no qualified check template",
                policy.policy_id
            )
        })?;
        if template.scope != policy.trigger.scope {
            return Err(
                "active policy check template scope does not match policy trigger".to_string(),
            );
        }
        additions
            .entry(template.check_id.clone())
            .or_insert_with(|| template.clone());
    }
    plan.selected_checks.extend(additions.into_values());
    plan.selected_checks
        .sort_by(|left, right| left.check_id.cmp(&right.check_id));
    plan.selected_checks
        .dedup_by(|left, right| left.check_id == right.check_id);
    let effective_ids = plan
        .selected_checks
        .iter()
        .map(|check| check.check_id.clone())
        .collect::<BTreeSet<_>>();
    if !base_check_ids.is_subset(&effective_ids) {
        return Err("M11 additive overlay attempted to remove an M6 base check".to_string());
    }
    if plan.assurance != base_plan.assurance {
        return Err("M11 additive overlay attempted to alter M6 assurance".to_string());
    }
    if plan.unresolved_obligations != base_plan.unresolved_obligations {
        return Err(
            "M11 additive overlay attempted to alter M6 unresolved obligations".to_string(),
        );
    }
    let added_check_ids = effective_ids
        .difference(&base_check_ids)
        .cloned()
        .collect::<Vec<_>>();
    let base_plan_digest = sha256_bytes(
        serde_json::to_vec(base_plan)
            .map_err(|error| format!("failed to serialize base plan: {error}"))?
            .as_slice(),
    );
    let effective_plan_digest = sha256_bytes(
        serde_json::to_vec(&plan)
            .map_err(|error| format!("failed to serialize effective plan: {error}"))?
            .as_slice(),
    );
    let mut application = PolicyApplication {
        application_id: String::new(),
        base_plan_digest,
        policy_snapshot_digest: snapshot.snapshot_digest.clone(),
        effective_plan_digest,
        added_check_ids: added_check_ids.clone(),
        application_digest: String::new(),
    };
    application.application_digest = compute_application_digest(&application)?;
    application.application_id = format!("policyapp_{}", application.application_digest);
    Ok(EffectiveVerificationPlan {
        plan,
        application,
        base_assurance: base_plan.assurance,
        base_check_ids: base_check_ids.into_iter().collect(),
        added_check_ids,
    })
}

pub fn persist_policy_application(
    conn: &Connection,
    application: &PolicyApplication,
    applied_at_ms: u64,
) -> Result<(), String> {
    conn.execute(
        r#"INSERT OR IGNORE INTO policy_applications (
            application_id, base_plan_digest, policy_snapshot_digest, effective_plan_digest,
            added_check_ids_json, application_digest, applied_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
        params![
            application.application_id,
            application.base_plan_digest,
            application.policy_snapshot_digest,
            application.effective_plan_digest,
            serde_json::to_string(&application.added_check_ids)
                .map_err(|error| format!("failed to serialize policy additions: {error}"))?,
            application.application_digest,
            applied_at_ms as i64,
        ],
    )
    .map_err(|error| format!("failed to persist policy application: {error}"))?;
    Ok(())
}
