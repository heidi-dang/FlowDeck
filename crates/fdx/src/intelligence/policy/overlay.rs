use crate::intelligence::policy::identity::{
    compute_application_digest, compute_snapshot_digest, compute_template_digest,
    compute_verification_plan_digest,
};
use crate::intelligence::policy::model::{
    EffectiveVerificationPlan, LearnedPolicyTrigger, PolicyAction, PolicyApplication,
    PolicySnapshot, PolicyState, PromotedPolicy, POLICY_CONTRACT_VERSION,
};
use crate::intelligence::runtime::sha256_bytes;
use crate::intelligence::testplan::discover::fallback_scope_ids_for_dir;
use crate::intelligence::testplan::model::{PlannedCheck, SelectionReason, VerificationPlan};
use crate::protocol::EvidenceStrength;
use crate::{
    intelligence::build::discover::discover_fallback_build_inventory,
    intelligence::build::snapshot::CurrentBuildSnapshot,
};
use rusqlite::{params, Connection};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub fn derive_impacted_scopes(repo_root: &Path, base_plan: &VerificationPlan) -> BTreeSet<String> {
    let fallback_inv = discover_fallback_build_inventory(repo_root);
    let build_snapshot = CurrentBuildSnapshot::build(repo_root);
    let mut affected = BTreeSet::new();
    for check in &base_plan.selected_checks {
        affected.insert(check.scope.clone());
    }
    for impacted in &base_plan.impacted_targets {
        if impacted.target.starts_with("pkg:") {
            affected.insert(impacted.target.clone());
        }
    }
    for change in &base_plan.changed {
        if let Some(packages) = build_snapshot.contains_file_to_packages.get(&change.file) {
            affected.extend(packages.iter().cloned());
        }
        for pkg_dir in &fallback_inv.package_dirs {
            let path = Path::new(&change.file);
            if path.starts_with(pkg_dir) || pkg_dir == "." {
                affected.extend(fallback_scope_ids_for_dir(repo_root, pkg_dir));
            }
        }
    }
    affected
}

/// Read every persisted policy row before filtering to active policies. A malformed historical
/// state/action must fail closed instead of being hidden by a SQL `WHERE state = 'promoted'`.
pub fn active_policy_snapshot(conn: &Connection) -> Result<PolicySnapshot, String> {
    let mut statement = conn
        .prepare(
            r#"SELECT policy_id, policy_contract_version, candidate_id, action, trigger_kind,
                       trigger_scope, check_id, template_digest, candidate_digest,
                       promotion_policy_digest, promoted_policy_digest, state, promoted_at_ms,
                       revoked_at_ms, revoke_reason
                FROM promoted_policies ORDER BY policy_id ASC"#,
        )
        .map_err(|error| format!("failed to prepare policy snapshot: {error}"))?;
    let persisted = statement
        .query_map([], |row| {
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
        })
        .map_err(|error| format!("failed to query policy snapshot: {error}"))?
        .map(|row| row.map_err(|error| format!("invalid persisted policy row: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    for policy in &persisted {
        validate_persisted_policy_identity(policy)?;
    }
    let policies = persisted
        .into_iter()
        .filter(|policy| policy.state == PolicyState::Promoted)
        .collect::<Vec<_>>();
    let mut snapshot = PolicySnapshot {
        policies,
        snapshot_digest: String::new(),
    };
    snapshot.snapshot_digest = compute_snapshot_digest(&snapshot)?;
    Ok(snapshot)
}

fn validate_persisted_policy_identity(policy: &PromotedPolicy) -> Result<(), String> {
    if policy.policy_contract_version != POLICY_CONTRACT_VERSION
        || policy.policy_id.is_empty()
        || policy.candidate_id.is_empty()
        || policy.check_id.is_empty()
        || policy.template_digest.is_empty()
        || policy.candidate_digest.is_empty()
        || policy.promotion_policy_digest.is_empty()
        || policy.promoted_policy_digest.is_empty()
    {
        return Err("policy snapshot contains missing or unsupported policy identity".to_string());
    }
    if policy.action != PolicyAction::AddCheck || policy.trigger.kind != "scope" {
        return Err(
            "policy snapshot contains non-additive or unsupported policy authority".to_string(),
        );
    }
    match policy.state {
        PolicyState::Promoted if policy.revoked_at_ms.is_none() => {}
        PolicyState::Revoked if policy.revoked_at_ms.is_some() => {}
        PolicyState::Promoted | PolicyState::Revoked => {
            return Err(
                "policy snapshot contains inconsistent revocation lifecycle fields".to_string(),
            );
        }
        _ => {
            return Err(
                "policy snapshot contains unsupported promoted-policy lifecycle state".to_string(),
            );
        }
    }
    LearnedPolicyTrigger::scope(policy.trigger.scope.clone())?;
    let expected_digest = sha256_bytes(
        format!(
            "{}:{}:{}:{}:{}:{}:{}",
            POLICY_CONTRACT_VERSION,
            policy.candidate_id,
            PolicyAction::AddCheck.as_str(),
            policy.trigger.kind,
            policy.trigger.scope,
            policy.check_id,
            policy.template_digest
        )
        .as_bytes(),
    );
    let expected_id = format!(
        "policy_{}",
        sha256_bytes(
            format!(
                "{}:{}:{}:{}",
                policy.candidate_id,
                policy.candidate_digest,
                policy.promotion_policy_digest,
                policy.template_digest
            )
            .as_bytes()
        )
    );
    if policy.promoted_policy_digest != expected_digest || policy.policy_id != expected_id {
        return Err(
            "policy snapshot contains a template-unbound or corrupt policy digest".to_string(),
        );
    }
    Ok(())
}

/// Load and validate exact policy templates. The returned map is keyed by immutable template
/// digest, not a mutable check identifier. Later plan construction never consults discovery.
pub fn load_persisted_overlay_templates(
    conn: &Connection,
    snapshot: &PolicySnapshot,
) -> Result<BTreeMap<String, PlannedCheck>, String> {
    let mut templates = BTreeMap::new();
    for policy in &snapshot.policies {
        let (check_id, planned_check_json, calibration_id, artifact_sha256, record_digest): (
            String,
            String,
            String,
            String,
            String,
        ) = conn
            .query_row(
                r#"SELECT check_id, planned_check_json, source_calibration_id,
                           source_artifact_sha256, source_record_digest
                    FROM policy_check_templates WHERE template_digest = ?1"#,
                params![policy.template_digest],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .map_err(|error| {
                format!(
                    "active policy '{}' has no readable persisted template: {error}",
                    policy.policy_id
                )
            })?;
        let template: PlannedCheck =
            serde_json::from_str(&planned_check_json).map_err(|error| {
                format!(
                    "active policy '{}' has corrupt persisted template JSON: {error}",
                    policy.policy_id
                )
            })?;
        if compute_template_digest(&template)? != policy.template_digest
            || check_id != policy.check_id
            || template.check_id != policy.check_id
            || template.scope != policy.trigger.scope
            || template.selection != SelectionReason::PolicyWidening
            || template.strength != EvidenceStrength::Structural
            || template.widening_reason.as_deref() != Some("learned_policy_add_check")
        {
            return Err(
                "active policy persisted template does not match immutable policy identity"
                    .to_string(),
            );
        }
        revalidate_template_provenance(
            conn,
            policy,
            &calibration_id,
            &artifact_sha256,
            &record_digest,
        )?;
        if let Some(previous) = templates.insert(policy.template_digest.clone(), template.clone()) {
            if previous != template {
                return Err(
                    "different persisted templates share a policy template digest".to_string(),
                );
            }
        }
    }
    Ok(templates)
}

fn revalidate_template_provenance(
    conn: &Connection,
    policy: &PromotedPolicy,
    calibration_id: &str,
    artifact_sha256: &str,
    record_digest: &str,
) -> Result<(), String> {
    let qualified: i64 = conn
        .query_row(
            r#"SELECT COUNT(*)
                FROM policy_candidate_evidence e
                JOIN calibration_runs r ON r.calibration_id = e.calibration_id
                JOIN calibration_metrics m ON m.calibration_id = r.calibration_id
                JOIN calibration_checks c ON c.calibration_id = r.calibration_id AND c.check_id = e.check_id
                WHERE e.candidate_id = ?1
                  AND e.calibration_id = ?2
                  AND e.source_artifact_sha256 = ?3
                  AND e.calibration_record_digest = ?4
                  AND e.check_id = ?5
                  AND r.calibration_contract_version = 2
                  AND r.status = 'complete'
                  AND r.reference_truncated = 0
                  AND r.source_artifact_sha256 = e.source_artifact_sha256
                  AND r.record_digest = e.calibration_record_digest
                  AND r.candidate_plan_digest = e.candidate_plan_digest
                  AND m.shadow_incomplete_count = 0
                  AND m.eligible_for_miss_rate = 1
                  AND c.scope = ?6
                  AND c.candidate_selected = 0
                  AND c.reference_selected = 1
                  AND c.has_physical_execution = 1
                  AND c.execution_status = 'failed'
                  AND c.signal_class = 'observed_shadow_miss'
                  AND c.is_observed_shadow_miss = 1"#,
            params![
                policy.candidate_id,
                calibration_id,
                artifact_sha256,
                record_digest,
                policy.check_id,
                policy.trigger.scope,
            ],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to revalidate persisted template provenance: {error}"))?;
    if qualified != 1 {
        return Err(
            "active policy template provenance is not one qualified non-policy M10 observation"
                .to_string(),
        );
    }
    Ok(())
}

/// Overlay active policy additions over a cloned M6 plan. The caller supplies only templates
/// loaded from `policy_check_templates`, keyed by template digest. Missing or corrupt bindings
/// fail closed; this function never removes base checks or changes assurance/obligations.
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
        validate_persisted_policy_identity(policy)?;
        if policy.state != PolicyState::Promoted {
            return Err("M11 refuses non-promoted policy during overlay".to_string());
        }
        if !impacted_scopes.contains(&policy.trigger.scope)
            || base_check_ids.contains(&policy.check_id)
        {
            continue;
        }
        let template = templates.get(&policy.template_digest).ok_or_else(|| {
            format!(
                "active policy '{}' has no immutable persisted check template",
                policy.policy_id
            )
        })?;
        if compute_template_digest(template)? != policy.template_digest
            || template.check_id != policy.check_id
            || template.scope != policy.trigger.scope
            || template.selection != SelectionReason::PolicyWidening
            || template.strength != EvidenceStrength::Structural
            || template.widening_reason.as_deref() != Some("learned_policy_add_check")
        {
            return Err(
                "active policy check template fails immutable binding validation".to_string(),
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
    let base_plan_digest = compute_verification_plan_digest(base_plan)?;
    let effective_plan_digest = compute_verification_plan_digest(&plan)?;
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

pub fn plan_with_policy_overlay(
    repo_root: &Path,
    conn: &Connection,
    base: Option<&str>,
    head: Option<&str>,
) -> Result<EffectiveVerificationPlan, String> {
    let base_plan =
        crate::intelligence::testplan::planner::plan_verification(repo_root, base, head, None)
            .map_err(|error| format!("failed to create frozen M6 base plan: {error}"))?;
    let snapshot = active_policy_snapshot(conn)?;
    if snapshot.policies.is_empty() {
        return no_policy_effective_plan(base_plan, snapshot);
    }
    let impacted_scopes = derive_impacted_scopes(repo_root, &base_plan);
    let templates = load_persisted_overlay_templates(conn, &snapshot)?;
    apply_additive_overlay(&base_plan, &snapshot, &templates, &impacted_scopes)
}

fn no_policy_effective_plan(
    base_plan: VerificationPlan,
    snapshot: PolicySnapshot,
) -> Result<EffectiveVerificationPlan, String> {
    let base_plan_digest = compute_verification_plan_digest(&base_plan)?;
    let mut application = PolicyApplication {
        application_id: String::new(),
        base_plan_digest: base_plan_digest.clone(),
        policy_snapshot_digest: snapshot.snapshot_digest,
        effective_plan_digest: base_plan_digest,
        added_check_ids: Vec::new(),
        application_digest: String::new(),
    };
    application.application_digest = compute_application_digest(&application)?;
    application.application_id = format!("policyapp_{}", application.application_digest);
    Ok(EffectiveVerificationPlan {
        base_assurance: base_plan.assurance,
        base_check_ids: base_plan
            .selected_checks
            .iter()
            .map(|check| check.check_id.clone())
            .collect(),
        plan: base_plan,
        application,
        added_check_ids: Vec::new(),
    })
}

pub fn persist_policy_application(
    conn: &Connection,
    application: &PolicyApplication,
    applied_at_ms: u64,
) -> Result<(), String> {
    conn.execute(
        r#"INSERT INTO policy_applications (
            application_id, base_plan_digest, policy_snapshot_digest, effective_plan_digest,
            added_check_ids_json, application_digest, applied_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(application_digest) DO NOTHING"#,
        params![
            application.application_id,
            application.base_plan_digest,
            application.policy_snapshot_digest,
            application.effective_plan_digest,
            crate::intelligence::attestation::canonical::canonicalize_to_string(
                &application.added_check_ids
            )
            .map_err(|error| format!("failed to canonicalize policy additions: {error}"))?,
            application.application_digest,
            applied_at_ms as i64,
        ],
    )
    .map_err(|error| format!("failed to persist policy application: {error}"))?;
    Ok(())
}
