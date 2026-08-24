use crate::intelligence::policy::identity::{
    compute_candidate_digest, compute_promotion_policy_digest,
};
use crate::intelligence::policy::model::{
    LearnedPolicyTrigger, PolicyAction, PolicyCandidate, PolicyState, PromotedPolicy,
    PromotionPolicy, POLICY_CONTRACT_VERSION,
};
use crate::intelligence::runtime::sha256_bytes;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

pub fn promote_candidate(
    conn: &mut Connection,
    candidate_id: &str,
    policy: &PromotionPolicy,
    now_ms: u64,
) -> Result<PromotedPolicy, String> {
    let required_digest = compute_promotion_policy_digest(policy)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to begin policy promotion transaction: {error}"))?;
    let candidate = load_candidate(&tx, candidate_id)?
        .ok_or_else(|| format!("policy candidate '{candidate_id}' was not found"))?;
    if candidate.promotion_policy_digest != required_digest {
        return Err(
            "candidate promotion configuration is stale; regenerate candidate before promotion"
                .to_string(),
        );
    }
    if candidate.state == PolicyState::Promoted {
        let existing = load_policy_by_candidate(&tx, candidate_id)?
            .ok_or_else(|| "promoted candidate has no active policy record".to_string())?;
        tx.commit()
            .map_err(|error| format!("failed to commit idempotent promotion: {error}"))?;
        return Ok(existing);
    }
    if candidate.state != PolicyState::Eligible {
        return Err("candidate does not satisfy current promotion thresholds".to_string());
    }
    if compute_candidate_digest(&candidate)? != candidate.candidate_digest {
        return Err("candidate digest is corrupt; refusing promotion".to_string());
    }
    revalidate_candidate_evidence(&tx, &candidate, policy)?;
    let active_scope_policies: u32 = tx
        .query_row(
            "SELECT count(*) FROM promoted_policies WHERE state = 'promoted' AND trigger_kind = ?1 AND trigger_scope = ?2",
            params![candidate.trigger.kind, candidate.trigger.scope],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("failed to count active policies for trigger: {error}"))?
        .try_into()
        .map_err(|_| "invalid active policy count".to_string())?;
    if active_scope_policies >= policy.max_added_checks_per_trigger {
        return Err(
            "promotion would exceed the configured additive check cap for this trigger".to_string(),
        );
    }

    let policy_id = format!(
        "policy_{}",
        sha256_bytes(
            format!(
                "{}:{}:{}",
                candidate.candidate_id, candidate.candidate_digest, required_digest
            )
            .as_bytes()
        )
    );
    let policy_digest = sha256_bytes(
        format!(
            "{}:{}:{}:{}:{}:{}",
            POLICY_CONTRACT_VERSION,
            candidate.candidate_id,
            PolicyAction::AddCheck.as_str(),
            candidate.trigger.kind,
            candidate.trigger.scope,
            candidate.check_id
        )
        .as_bytes(),
    );
    let promoted = PromotedPolicy {
        policy_id: policy_id.clone(),
        policy_contract_version: POLICY_CONTRACT_VERSION,
        candidate_id: candidate.candidate_id.clone(),
        action: PolicyAction::AddCheck,
        trigger: candidate.trigger.clone(),
        check_id: candidate.check_id.clone(),
        candidate_digest: candidate.candidate_digest.clone(),
        promotion_policy_digest: required_digest,
        promoted_policy_digest: policy_digest.clone(),
        state: PolicyState::Promoted,
        promoted_at_ms: now_ms,
        revoked_at_ms: None,
        revoke_reason: None,
    };
    tx.execute(
        r#"INSERT INTO promoted_policies (
            policy_id, policy_contract_version, candidate_id, action, trigger_kind, trigger_scope,
            check_id, candidate_digest, promotion_policy_digest, promoted_policy_digest, state,
            promoted_at_ms, revoked_at_ms, revoke_reason
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, NULL)"#,
        params![
            promoted.policy_id,
            promoted.policy_contract_version as i64,
            promoted.candidate_id,
            promoted.action.as_str(),
            promoted.trigger.kind,
            promoted.trigger.scope,
            promoted.check_id,
            promoted.candidate_digest,
            promoted.promotion_policy_digest,
            promoted.promoted_policy_digest,
            promoted.state.as_str(),
            promoted.promoted_at_ms as i64,
        ],
    )
    .map_err(|error| format!("failed to persist promoted policy: {error}"))?;
    tx.execute(
        "UPDATE policy_candidates SET state = 'promoted', promoted_policy_id = ?2, updated_at_ms = ?3 WHERE candidate_id = ?1",
        params![candidate_id, policy_id, now_ms as i64],
    )
    .map_err(|error| format!("failed to mark policy candidate promoted: {error}"))?;
    let event_digest =
        sha256_bytes(format!("promotion:{}:{}", policy_id, policy_digest).as_bytes());
    tx.execute(
        "INSERT INTO policy_events (event_id, policy_id, event_kind, event_digest, reason, created_at_ms) VALUES (?1, ?2, 'promoted', ?3, NULL, ?4)",
        params![format!("event_{event_digest}"), policy_id, event_digest, now_ms as i64],
    )
    .map_err(|error| format!("failed to append promotion event: {error}"))?;
    tx.commit()
        .map_err(|error| format!("failed to commit policy promotion: {error}"))?;
    Ok(promoted)
}

pub fn revoke_policy(
    conn: &mut Connection,
    policy_id: &str,
    reason: &str,
    now_ms: u64,
) -> Result<(), String> {
    if reason.trim().is_empty()
        || reason.contains("/home/")
        || reason.contains("/Users/")
        || reason.contains("Bearer ")
        || reason.contains("sk-")
    {
        return Err(
            "revocation reason is empty or contains disallowed private material".to_string(),
        );
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to begin policy revocation transaction: {error}"))?;
    let candidate_id: String = tx
        .query_row(
            "SELECT candidate_id FROM promoted_policies WHERE policy_id = ?1",
            params![policy_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("failed to load policy for revocation: {error}"))?
        .ok_or_else(|| format!("policy '{policy_id}' was not found"))?;
    let changed = tx
        .execute(
            "UPDATE promoted_policies SET state = 'revoked', revoked_at_ms = ?2, revoke_reason = ?3 WHERE policy_id = ?1 AND state = 'promoted'",
            params![policy_id, now_ms as i64, reason],
        )
        .map_err(|error| format!("failed to revoke policy: {error}"))?;
    if changed == 0 {
        tx.commit()
            .map_err(|error| format!("failed to commit idempotent revocation: {error}"))?;
        return Ok(());
    }
    tx.execute(
        "UPDATE policy_candidates SET state = 'revoked', updated_at_ms = ?2 WHERE candidate_id = ?1",
        params![candidate_id, now_ms as i64],
    )
    .map_err(|error| format!("failed to update revoked candidate: {error}"))?;
    let event_digest = sha256_bytes(format!("revocation:{policy_id}:{reason}:{now_ms}").as_bytes());
    tx.execute(
        "INSERT OR IGNORE INTO policy_events (event_id, policy_id, event_kind, event_digest, reason, created_at_ms) VALUES (?1, ?2, 'revoked', ?3, ?4, ?5)",
        params![format!("event_{event_digest}"), policy_id, event_digest, reason, now_ms as i64],
    )
    .map_err(|error| format!("failed to append revocation event: {error}"))?;
    tx.commit()
        .map_err(|error| format!("failed to commit policy revocation: {error}"))?;
    Ok(())
}

fn revalidate_candidate_evidence(
    conn: &Connection,
    candidate: &PolicyCandidate,
    policy: &PromotionPolicy,
) -> Result<(), String> {
    let (calibrations, artifacts, plans, max_duration): (i64, i64, i64, i64) = conn
        .query_row(
            r#"SELECT COUNT(DISTINCT e.calibration_id),
                       COUNT(DISTINCT e.source_artifact_sha256),
                       COUNT(DISTINCT e.candidate_plan_digest),
                       COALESCE(MAX(c.duration_ms), 0)
                FROM policy_candidate_evidence e
                JOIN calibration_runs r ON r.calibration_id = e.calibration_id
                JOIN calibration_metrics m ON m.calibration_id = r.calibration_id
                JOIN calibration_checks c ON c.calibration_id = r.calibration_id AND c.check_id = e.check_id
                WHERE e.candidate_id = ?1
                  AND e.check_id = ?2
                  AND r.calibration_contract_version = 2
                  AND r.status = 'complete'
                  AND r.reference_truncated = 0
                  AND r.source_artifact_sha256 = e.source_artifact_sha256
                  AND r.record_digest = e.calibration_record_digest
                  AND r.candidate_plan_digest = e.candidate_plan_digest
                  AND m.shadow_incomplete_count = 0
                  AND m.eligible_for_miss_rate = 1
                  AND c.candidate_selected = 0
                  AND c.reference_selected = 1
                  AND c.has_physical_execution = 1
                  AND c.execution_status = 'failed'
                  AND c.signal_class = 'observed_shadow_miss'
                  AND c.is_observed_shadow_miss = 1"#,
            params![candidate.candidate_id, candidate.check_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| format!("failed to revalidate candidate evidence: {error}"))?;
    let support: u32 = calibrations
        .try_into()
        .map_err(|_| "invalid revalidated support count".to_string())?;
    let artifact_count: u32 = artifacts
        .try_into()
        .map_err(|_| "invalid revalidated artifact count".to_string())?;
    let plan_count: u32 = plans
        .try_into()
        .map_err(|_| "invalid revalidated plan count".to_string())?;
    let runtime: u64 = max_duration
        .try_into()
        .map_err(|_| "invalid revalidated duration".to_string())?;
    if support != candidate.support_count
        || artifact_count != candidate.distinct_source_artifact_count
        || plan_count != candidate.distinct_change_fingerprint_count
        || runtime != candidate.estimated_added_runtime_ms
        || support < policy.min_observed_misses
        || artifact_count < policy.min_distinct_source_artifacts
        || plan_count < policy.min_distinct_change_fingerprints
        || runtime > policy.max_estimated_added_runtime_ms
    {
        return Err(
            "candidate evidence no longer satisfies qualified promotion requirements".to_string(),
        );
    }
    Ok(())
}

fn load_candidate(
    conn: &Connection,
    candidate_id: &str,
) -> Result<Option<PolicyCandidate>, String> {
    conn.query_row(
        r#"SELECT candidate_contract_version, trigger_kind, trigger_scope, check_id, candidate_digest,
                   promotion_policy_digest, support_count, distinct_source_artifact_count,
                   distinct_change_fingerprint_count, estimated_added_runtime_ms, state, created_at_ms,
                   updated_at_ms, promoted_policy_id
            FROM policy_candidates WHERE candidate_id = ?1"#,
        params![candidate_id],
        |row| {
            Ok(PolicyCandidate {
                candidate_id: candidate_id.to_string(),
                candidate_contract_version: row.get::<_, i64>(0)? as u32,
                trigger: LearnedPolicyTrigger { kind: row.get(1)?, scope: row.get(2)? },
                check_id: row.get(3)?,
                candidate_digest: row.get(4)?,
                promotion_policy_digest: row.get(5)?,
                support_count: row.get::<_, i64>(6)? as u32,
                distinct_source_artifact_count: row.get::<_, i64>(7)? as u32,
                distinct_change_fingerprint_count: row.get::<_, i64>(8)? as u32,
                estimated_added_runtime_ms: row.get::<_, i64>(9)? as u64,
                state: PolicyState::parse(&row.get::<_, String>(10)?).map_err(|_| rusqlite::Error::InvalidQuery)?,
                created_at_ms: row.get::<_, i64>(11)? as u64,
                updated_at_ms: row.get::<_, i64>(12)? as u64,
                promoted_policy_id: row.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("invalid persisted policy candidate: {error}"))
}

fn load_policy_by_candidate(
    conn: &Connection,
    candidate_id: &str,
) -> Result<Option<PromotedPolicy>, String> {
    conn.query_row(
        r#"SELECT policy_id, policy_contract_version, action, trigger_kind, trigger_scope, check_id,
                   candidate_digest, promotion_policy_digest, promoted_policy_digest, state, promoted_at_ms,
                   revoked_at_ms, revoke_reason
            FROM promoted_policies WHERE candidate_id = ?1"#,
        params![candidate_id],
        |row| {
            Ok(PromotedPolicy {
                policy_id: row.get(0)?,
                policy_contract_version: row.get::<_, i64>(1)? as u32,
                candidate_id: candidate_id.to_string(),
                action: PolicyAction::parse(&row.get::<_, String>(2)?).map_err(|_| rusqlite::Error::InvalidQuery)?,
                trigger: LearnedPolicyTrigger { kind: row.get(3)?, scope: row.get(4)? },
                check_id: row.get(5)?,
                candidate_digest: row.get(6)?,
                promotion_policy_digest: row.get(7)?,
                promoted_policy_digest: row.get(8)?,
                state: PolicyState::parse(&row.get::<_, String>(9)?).map_err(|_| rusqlite::Error::InvalidQuery)?,
                promoted_at_ms: row.get::<_, i64>(10)? as u64,
                revoked_at_ms: row.get::<_, Option<i64>>(11)?.map(|value| value as u64),
                revoke_reason: row.get(12)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("invalid persisted promoted policy: {error}"))
}
