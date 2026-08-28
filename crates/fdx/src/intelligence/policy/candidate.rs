use crate::intelligence::calibration::model::CALIBRATION_CONTRACT_VERSION;
use crate::intelligence::policy::identity::{
    compute_candidate_digest, compute_promotion_policy_digest, generate_candidate_id,
};
use crate::intelligence::policy::model::{
    LearnedPolicyTrigger, PolicyCandidate, PolicyState, PromotionPolicy, POLICY_CONTRACT_VERSION,
};
use rusqlite::{params, Connection};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
struct QualifiedMiss {
    calibration_id: String,
    source_artifact_sha256: String,
    candidate_plan_digest: String,
    record_digest: String,
    scope: String,
    check_id: String,
    duration_ms: u64,
    observed_at_ms: u64,
}

/// Generate candidates from current-contract, complete M10 observed-shadow-miss evidence only.
/// This function persists descriptive candidates; it has zero planner authority.
pub fn generate_candidates(
    conn: &mut Connection,
    policy: &PromotionPolicy,
    now_ms: u64,
) -> Result<Vec<PolicyCandidate>, String> {
    let policy_digest = compute_promotion_policy_digest(policy)?;
    let misses = read_qualified_misses(conn, policy.lookback_limit)?;
    let mut grouped: BTreeMap<(String, String), Vec<QualifiedMiss>> = BTreeMap::new();
    for miss in misses {
        grouped
            .entry((miss.scope.clone(), miss.check_id.clone()))
            .or_default()
            .push(miss);
    }

    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin policy candidate transaction: {error}"))?;
    let mut result = Vec::new();
    for ((scope, check_id), observations) in grouped {
        let trigger = LearnedPolicyTrigger::scope(scope)?;
        let candidate_id = generate_candidate_id(&trigger, &check_id, &policy_digest);
        let distinct_calibrations = observations
            .iter()
            .map(|item| item.calibration_id.clone())
            .collect::<BTreeSet<_>>();
        let distinct_artifacts = observations
            .iter()
            .map(|item| item.source_artifact_sha256.clone())
            .collect::<BTreeSet<_>>();
        let distinct_changes = observations
            .iter()
            .map(|item| item.candidate_plan_digest.clone())
            .collect::<BTreeSet<_>>();
        let estimated_added_runtime_ms = observations
            .iter()
            .map(|item| item.duration_ms)
            .max()
            .unwrap_or(0);
        let eligible = distinct_calibrations.len() >= policy.min_observed_misses as usize
            && distinct_artifacts.len() >= policy.min_distinct_source_artifacts as usize
            && distinct_changes.len() >= policy.min_distinct_change_fingerprints as usize
            && estimated_added_runtime_ms <= policy.max_estimated_added_runtime_ms;
        let mut candidate = PolicyCandidate {
            candidate_id: candidate_id.clone(),
            candidate_contract_version: POLICY_CONTRACT_VERSION,
            trigger,
            check_id: check_id.clone(),
            candidate_digest: String::new(),
            promotion_policy_digest: policy_digest.clone(),
            support_count: distinct_calibrations.len() as u32,
            distinct_source_artifact_count: distinct_artifacts.len() as u32,
            distinct_change_fingerprint_count: distinct_changes.len() as u32,
            estimated_added_runtime_ms,
            state: if eligible {
                PolicyState::Eligible
            } else {
                PolicyState::Candidate
            },
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            promoted_policy_id: None,
        };
        candidate.candidate_digest = compute_candidate_digest(&candidate)?;
        tx.execute(
            r#"INSERT INTO policy_candidates (
                candidate_id, candidate_contract_version, trigger_kind, trigger_scope, check_id,
                candidate_digest, promotion_policy_digest, support_count,
                distinct_source_artifact_count, distinct_change_fingerprint_count,
                estimated_added_runtime_ms, state, created_at_ms, updated_at_ms, promoted_policy_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL)
            ON CONFLICT(candidate_id) DO UPDATE SET
                candidate_digest=excluded.candidate_digest,
                support_count=excluded.support_count,
                distinct_source_artifact_count=excluded.distinct_source_artifact_count,
                distinct_change_fingerprint_count=excluded.distinct_change_fingerprint_count,
                estimated_added_runtime_ms=excluded.estimated_added_runtime_ms,
                state=excluded.state,
                updated_at_ms=excluded.updated_at_ms"#,
            params![
                candidate.candidate_id,
                candidate.candidate_contract_version as i64,
                candidate.trigger.kind,
                candidate.trigger.scope,
                candidate.check_id,
                candidate.candidate_digest,
                candidate.promotion_policy_digest,
                candidate.support_count as i64,
                candidate.distinct_source_artifact_count as i64,
                candidate.distinct_change_fingerprint_count as i64,
                candidate.estimated_added_runtime_ms as i64,
                candidate.state.as_str(),
                candidate.created_at_ms as i64,
                candidate.updated_at_ms as i64,
            ],
        )
        .map_err(|error| format!("failed to persist policy candidate: {error}"))?;
        for observation in observations {
            tx.execute(
                r#"INSERT OR IGNORE INTO policy_candidate_evidence (
                    candidate_id, calibration_id, source_artifact_sha256, candidate_plan_digest,
                    calibration_record_digest, check_id, observed_at_ms
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
                params![
                    candidate_id,
                    observation.calibration_id,
                    observation.source_artifact_sha256,
                    observation.candidate_plan_digest,
                    observation.record_digest,
                    check_id,
                    observation.observed_at_ms as i64,
                ],
            )
            .map_err(|error| format!("failed to persist policy candidate evidence: {error}"))?;
        }
        result.push(candidate);
    }
    tx.commit()
        .map_err(|error| format!("failed to commit policy candidate generation: {error}"))?;
    Ok(result)
}

fn read_qualified_misses(
    conn: &Connection,
    lookback_limit: u32,
) -> Result<Vec<QualifiedMiss>, String> {
    let mut statement = conn
        .prepare(
            r#"WITH qualified_runs AS (
                    SELECT r.calibration_id
                    FROM calibration_runs r
                    JOIN calibration_metrics m ON m.calibration_id = r.calibration_id
                    WHERE r.calibration_contract_version = ?1
                      AND r.status = 'complete'
                      AND r.reference_truncated = 0
                      AND r.source_artifact_sha256 IS NOT NULL
                      AND r.record_digest IS NOT NULL
                      AND m.shadow_incomplete_count = 0
                      AND m.eligible_for_miss_rate = 1
                    ORDER BY r.started_at_ms DESC, r.calibration_id ASC
                    LIMIT ?2
                )
                SELECT r.calibration_id, r.source_artifact_sha256, r.candidate_plan_digest,
                       r.record_digest, r.started_at_ms, c.scope, c.check_id, c.duration_ms
                FROM qualified_runs q
                JOIN calibration_runs r ON r.calibration_id = q.calibration_id
                JOIN calibration_checks c ON c.calibration_id = r.calibration_id
                WHERE c.candidate_selected = 0
                  AND c.reference_selected = 1
                  AND c.has_physical_execution = 1
                  AND c.execution_status = 'failed'
                  AND c.signal_class = 'observed_shadow_miss'
                  AND c.is_observed_shadow_miss = 1
                ORDER BY r.started_at_ms DESC, r.calibration_id ASC, c.check_id ASC"#,
        )
        .map_err(|error| format!("failed to prepare qualified policy evidence query: {error}"))?;
    let rows = statement
        .query_map(
            params![CALIBRATION_CONTRACT_VERSION as i64, lookback_limit as i64],
            |row| {
                Ok(QualifiedMiss {
                    calibration_id: row.get(0)?,
                    source_artifact_sha256: row.get(1)?,
                    candidate_plan_digest: row.get(2)?,
                    record_digest: row.get(3)?,
                    observed_at_ms: u64::try_from(row.get::<_, i64>(4)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                    scope: row.get(5)?,
                    check_id: row.get(6)?,
                    duration_ms: u64::try_from(row.get::<_, i64>(7)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                })
            },
        )
        .map_err(|error| format!("failed to query qualified policy evidence: {error}"))?;
    rows.map(|row| row.map_err(|error| format!("invalid qualified policy evidence row: {error}")))
        .collect()
}

/// Read persisted policy candidates in stable recency and identifier order. This API is
/// descriptive only; promotion remains an explicit separate operation.
pub fn list_candidates(conn: &Connection, limit: u32) -> Result<Vec<PolicyCandidate>, String> {
    let mut statement = conn
        .prepare(
            r#"SELECT candidate_id, candidate_contract_version, trigger_kind, trigger_scope,
                       check_id, candidate_digest, promotion_policy_digest, support_count,
                       distinct_source_artifact_count, distinct_change_fingerprint_count,
                       estimated_added_runtime_ms, state, created_at_ms, updated_at_ms,
                       promoted_policy_id
                FROM policy_candidates
                ORDER BY updated_at_ms DESC, candidate_id ASC
                LIMIT ?1"#,
        )
        .map_err(|error| format!("failed to prepare policy candidate listing: {error}"))?;
    let candidates = statement
        .query_map(params![limit as i64], policy_candidate_from_row)
        .map_err(|error| format!("failed to query policy candidates: {error}"))?
        .map(|row| row.map_err(|error| format!("invalid persisted policy candidate: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(candidates)
}

/// Read a single persisted policy candidate and fail closed on unknown state encodings.
pub fn get_candidate(
    conn: &Connection,
    candidate_id: &str,
) -> Result<Option<PolicyCandidate>, String> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        r#"SELECT candidate_id, candidate_contract_version, trigger_kind, trigger_scope,
                   check_id, candidate_digest, promotion_policy_digest, support_count,
                   distinct_source_artifact_count, distinct_change_fingerprint_count,
                   estimated_added_runtime_ms, state, created_at_ms, updated_at_ms,
                   promoted_policy_id
            FROM policy_candidates WHERE candidate_id = ?1"#,
        params![candidate_id],
        policy_candidate_from_row,
    )
    .optional()
    .map_err(|error| format!("invalid persisted policy candidate: {error}"))
}

fn policy_candidate_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PolicyCandidate> {
    Ok(PolicyCandidate {
        candidate_id: row.get(0)?,
        candidate_contract_version: row.get::<_, i64>(1)? as u32,
        trigger: LearnedPolicyTrigger {
            kind: row.get(2)?,
            scope: row.get(3)?,
        },
        check_id: row.get(4)?,
        candidate_digest: row.get(5)?,
        promotion_policy_digest: row.get(6)?,
        support_count: row.get::<_, i64>(7)? as u32,
        distinct_source_artifact_count: row.get::<_, i64>(8)? as u32,
        distinct_change_fingerprint_count: row.get::<_, i64>(9)? as u32,
        estimated_added_runtime_ms: row.get::<_, i64>(10)? as u64,
        state: PolicyState::parse(&row.get::<_, String>(11)?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        created_at_ms: row.get::<_, i64>(12)? as u64,
        updated_at_ms: row.get::<_, i64>(13)? as u64,
        promoted_policy_id: row.get(14)?,
    })
}
