//! Attestation statement verification and cryptographic tamper detection.

use crate::intelligence::attestation::canonical::canonicalize_to_vec;
use crate::intelligence::attestation::model::{
    AttestedUncertainty, AttestedUnresolvedObligation, VerificationAttestation,
    FDX_ATTESTATION_PREDICATE_VERSION, FDX_VERIFICATION_PREDICATE_V1_TYPE,
    IN_TOTO_STATEMENT_V1_TYPE,
};
use crate::intelligence::runtime::model::INGESTION_CONTRACT_VERSION_V2;
use crate::intelligence::runtime::query::get_historical_run;
use crate::intelligence::runtime::{compute_plan_digest, sha256_bytes};
use crate::intelligence::verify::model::{VerificationOutcome, VerificationRun};
use crate::intelligence::verify::persist::run_artifact_path;
use crate::intelligence::verify::redact::redact_secrets;
use crate::protocol::AssuranceLevel;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

/// Detailed result of attestation verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttestationVerificationReport {
    pub valid: bool,
    pub run_id: String,
    pub artifact_sha256: String,
    pub attestation_sha256: String,
    pub outcome: VerificationOutcome,
    pub assurance: AssuranceLevel,
    pub checks_verified: usize,
    pub executions_verified: usize,
    pub global_history_complete_at_generation: bool,
}

/// Verify an in-toto attestation against persisted M7 run artifact and M8 SQLite history.
pub fn verify_attestation(
    repo_root: &Path,
    attestation: &VerificationAttestation,
    raw_bytes: Option<&[u8]>,
    expected_sha256: Option<&str>,
    conn: &Connection,
) -> Result<AttestationVerificationReport, String> {
    // 1. Envelope type and version validation
    if attestation.statement_type != IN_TOTO_STATEMENT_V1_TYPE {
        return Err(format!(
            "Unsupported statement type {:?} (expected {:?})",
            attestation.statement_type, IN_TOTO_STATEMENT_V1_TYPE
        ));
    }
    if attestation.predicate_type != FDX_VERIFICATION_PREDICATE_V1_TYPE {
        return Err(format!(
            "Unsupported predicate type {:?} (expected {:?})",
            attestation.predicate_type, FDX_VERIFICATION_PREDICATE_V1_TYPE
        ));
    }
    if attestation.predicate.schema_version != FDX_ATTESTATION_PREDICATE_VERSION {
        return Err(format!(
            "Unsupported predicate schema version {} (expected {})",
            attestation.predicate.schema_version, FDX_ATTESTATION_PREDICATE_VERSION
        ));
    }

    // 2. Subject validation: exactly one subject allowed
    if attestation.subject.len() != 1 {
        return Err(format!(
            "Attestation must contain exactly 1 subject, found {}",
            attestation.subject.len()
        ));
    }
    let run_id = &attestation.predicate.run.run_id;
    let expected_subject_name = format!("fdx-verification-run:{}", run_id);
    if attestation.subject[0].name != expected_subject_name {
        return Err(format!(
            "Subject name mismatch: {:?} != expected {:?}",
            attestation.subject[0].name, expected_subject_name
        ));
    }
    if attestation.subject[0].digest.sha256 != attestation.predicate.run.artifact_sha256 {
        return Err(format!(
            "Subject digest mismatch with predicate: {:?} != {:?}",
            attestation.subject[0].digest.sha256, attestation.predicate.run.artifact_sha256
        ));
    }

    // 3. Compute and check canonical representation and byte identity
    let canonical_bytes = canonicalize_to_vec(attestation)?;
    let computed_attestation_sha256 = sha256_bytes(&canonical_bytes);

    if let Some(bytes) = raw_bytes {
        if bytes != canonical_bytes {
            return Err("Non-canonical raw attestation bytes rejected: raw file bytes must match exact RFC 8785 canonical bytes".to_string());
        }
    }

    if let Some(expected) = expected_sha256 {
        if computed_attestation_sha256 != expected {
            return Err(format!(
                "Attestation digest mismatch: computed {} != expected {}",
                computed_attestation_sha256, expected
            ));
        }
    }

    // 4. Verify exact M7 run artifact bytes on disk
    let artifact_path = run_artifact_path(repo_root, run_id);
    if !artifact_path.exists() {
        return Err(format!(
            "M7 run artifact not found at {:?}. Cannot verify attestation without source evidence.",
            artifact_path
        ));
    }
    let raw_artifact_bytes = fs::read(&artifact_path)
        .map_err(|e| format!("failed to read run artifact {:?}: {}", artifact_path, e))?;
    let disk_artifact_sha256 = sha256_bytes(&raw_artifact_bytes);

    if disk_artifact_sha256 != attestation.predicate.run.artifact_sha256 {
        return Err(format!(
            "Tamper detected: M7 artifact hash on disk ({}) != attested artifact hash ({})",
            disk_artifact_sha256, attestation.predicate.run.artifact_sha256
        ));
    }

    let run: VerificationRun = serde_json::from_slice(&raw_artifact_bytes)
        .map_err(|e| format!("failed to parse run artifact {:?}: {}", artifact_path, e))?;

    // Verify run identity metadata
    if run.run_id != attestation.predicate.run.run_id {
        return Err(format!(
            "Run ID mismatch: M7 artifact ({:?}) != attestation ({:?})",
            run.run_id, attestation.predicate.run.run_id
        ));
    }
    if run.executed_at_ms != attestation.predicate.run.executed_at_ms {
        return Err(format!(
            "Executed timestamp mismatch: M7 artifact ({}) != attestation ({})",
            run.executed_at_ms, attestation.predicate.run.executed_at_ms
        ));
    }
    if run.duration_ms != attestation.predicate.run.duration_ms {
        return Err(format!(
            "Duration mismatch: M7 artifact ({}) != attestation ({})",
            run.duration_ms, attestation.predicate.run.duration_ms
        ));
    }

    // Verify plan summary & recomputed plan digest
    let recomputed_plan_digest = compute_plan_digest(&run.plan)?;
    if recomputed_plan_digest != attestation.predicate.run.plan_sha256 {
        return Err(format!(
            "Plan digest mismatch in run identity: recomputed ({}) != attested ({})",
            recomputed_plan_digest, attestation.predicate.run.plan_sha256
        ));
    }
    if recomputed_plan_digest != attestation.predicate.plan.plan_sha256 {
        return Err(format!(
            "Plan digest mismatch in plan summary: recomputed ({}) != attested ({})",
            recomputed_plan_digest, attestation.predicate.plan.plan_sha256
        ));
    }

    let expected_plan_id = format!(
        "plan:{}",
        &recomputed_plan_digest[..16.min(recomputed_plan_digest.len())]
    );
    if attestation.predicate.plan.plan_id != expected_plan_id {
        return Err(format!(
            "Plan ID mismatch: attested ({:?}) != expected ({:?})",
            attestation.predicate.plan.plan_id, expected_plan_id
        ));
    }

    let expected_total = run.plan.selected_checks.len();
    let expected_mandatory = run
        .plan
        .selected_checks
        .iter()
        .filter(|c| c.mandatory)
        .count();
    let expected_advisory = expected_total - expected_mandatory;

    if attestation.predicate.plan.total_obligations != expected_total {
        return Err(format!(
            "Total obligations mismatch: attested ({}) != expected ({})",
            attestation.predicate.plan.total_obligations, expected_total
        ));
    }
    if attestation.predicate.plan.mandatory_obligations != expected_mandatory {
        return Err(format!(
            "Mandatory obligations mismatch: attested ({}) != expected ({})",
            attestation.predicate.plan.mandatory_obligations, expected_mandatory
        ));
    }
    if attestation.predicate.plan.advisory_obligations != expected_advisory {
        return Err(format!(
            "Advisory obligations mismatch: attested ({}) != expected ({})",
            attestation.predicate.plan.advisory_obligations, expected_advisory
        ));
    }
    if attestation.predicate.plan.mandatory_obligations
        + attestation.predicate.plan.advisory_obligations
        != attestation.predicate.plan.total_obligations
    {
        return Err(
            "Plan obligations invariant violated: mandatory + advisory != total".to_string(),
        );
    }

    // Verify result & unresolved obligations
    if run.outcome != attestation.predicate.result.outcome {
        return Err(format!(
            "Outcome tamper detected: M7 artifact ({:?}) != attestation ({:?})",
            run.outcome, attestation.predicate.result.outcome
        ));
    }
    if run.assurance != attestation.predicate.result.assurance {
        return Err(format!(
            "Assurance tamper detected: M7 artifact ({:?}) != attestation ({:?})",
            run.assurance, attestation.predicate.result.assurance
        ));
    }

    if attestation.predicate.result.unresolved_obligation_count
        != attestation.predicate.result.unresolved_obligations.len()
    {
        return Err("Unresolved obligation count does not match list length".to_string());
    }

    let mut expected_unresolved: Vec<AttestedUnresolvedObligation> = run
        .plan
        .unresolved_obligations
        .iter()
        .map(|u| AttestedUnresolvedObligation {
            scope: redact_secrets(&u.scope),
            reason: redact_secrets(&u.reason),
            source: redact_secrets(&u.source),
        })
        .collect();
    expected_unresolved
        .sort_by(|a, b| (&a.scope, &a.reason, &a.source).cmp(&(&b.scope, &b.reason, &b.source)));

    if attestation.predicate.result.unresolved_obligations != expected_unresolved {
        return Err("Unresolved obligations do not match M7 artifact projection".to_string());
    }

    // Verify uncertainties
    let mut expected_uncertainty_map: BTreeMap<
        (String, String, Option<String>),
        AttestedUncertainty,
    > = BTreeMap::new();
    for u in run.uncertainty.iter().chain(run.plan.uncertainty.iter()) {
        let code = u.code().to_string();
        let (message, target) = match u {
            crate::intelligence::change::uncertainty::UncertaintyReason::ProviderMissing(s) => (format!("provider missing: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::ProviderStale(s) => (format!("provider stale: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::ProviderFailed(s) => (format!("provider failed: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::UnsupportedLanguage(s) => (format!("unsupported language: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::SemanticChangeUnknown(s) => (format!("semantic change unknown: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::DepthLimitReached { max_depth } => (format!("depth limit reached: {}", max_depth), None),
            crate::intelligence::change::uncertainty::UncertaintyReason::NodeLimitReached { max_nodes } => (format!("node limit reached: {}", max_nodes), None),
            crate::intelligence::change::uncertainty::UncertaintyReason::EdgeLimitReached { max_edges } => (format!("edge limit reached: {}", max_edges), None),
            crate::intelligence::change::uncertainty::UncertaintyReason::AmbiguousSymbol(s) => (format!("ambiguous symbol: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::MissingBeforeEvidence(s) => (format!("missing before evidence: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::MissingAfterEvidence(s) => (format!("missing after evidence: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::FallbackUsed(s) => (format!("fallback used: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::GraphAbsent(s) => (format!("graph absent: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::GraphIncompatible(s) => (format!("graph incompatible: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::GraphCorrupt(s) => (format!("graph corrupt: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::GraphUnavailable(s) => (format!("graph unavailable: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::UnknownGraphRelation(s) => (format!("unknown graph relation: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::BuildProviderMissing(s) => (format!("build provider missing: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::BuildProviderStale(s) => (format!("build provider stale: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::BuildProviderFailed(s) => (format!("build provider failed: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::MalformedConfig(s) => (format!("malformed config: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::ConfigCycleDetected(s) => (format!("config cycle detected: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::UnknownWorkspaceMembership(s) => (format!("unknown workspace membership: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::DynamicConfigExpression(s) => (format!("dynamic config expression: {}", redact_secrets(s)), Some(redact_secrets(s))),
            crate::intelligence::change::uncertainty::UncertaintyReason::BuildLimitReached(s) => (format!("build limit reached: {}", redact_secrets(s)), Some(redact_secrets(s))),
        };
        let key = (code.clone(), message.clone(), target.clone());
        expected_uncertainty_map
            .entry(key)
            .or_insert_with(|| AttestedUncertainty {
                code,
                message,
                target,
            });
    }
    let expected_uncertainties: Vec<AttestedUncertainty> =
        expected_uncertainty_map.into_values().collect();

    if attestation.predicate.uncertainty != expected_uncertainties {
        return Err("Attested uncertainty does not match M7 artifact projection".to_string());
    }

    // Verify source context
    if attestation.predicate.source_context.base_ref != run.base {
        return Err(format!(
            "Source context base_ref mismatch: attested ({:?}) != M7 ({:?})",
            attestation.predicate.source_context.base_ref, run.base
        ));
    }
    if attestation.predicate.source_context.head_ref != run.head {
        return Err(format!(
            "Source context head_ref mismatch: attested ({:?}) != M7 ({:?})",
            attestation.predicate.source_context.head_ref, run.head
        ));
    }
    if attestation.predicate.source_context.changed_files_count != run.plan.changed.len() {
        return Err(format!(
            "Source context changed_files_count mismatch: attested ({}) != M7 ({})",
            attestation.predicate.source_context.changed_files_count,
            run.plan.changed.len()
        ));
    }
    if attestation.predicate.source_context.impacted_targets_count
        != run.plan.impacted_targets.len()
    {
        return Err(format!(
            "Source context impacted_targets_count mismatch: attested ({}) != M7 ({})",
            attestation.predicate.source_context.impacted_targets_count,
            run.plan.impacted_targets.len()
        ));
    }
    if attestation
        .predicate
        .source_context
        .workspace_clean
        .is_some()
    {
        return Err("Source context workspace_clean must be None in Predicate v1".to_string());
    }

    // 5. Verify M8 database records
    let historical = get_historical_run(conn, run_id)?
        .ok_or_else(|| format!("Run {:?} not found in M8 SQLite runtime history", run_id))?;
    let (run_obs, executions, check_obs) = historical;

    if run_obs.ingestion_contract_version != INGESTION_CONTRACT_VERSION_V2 {
        return Err(format!(
            "Run {:?} in database has unsupported contract version {} (expected exact version {})",
            run_id, run_obs.ingestion_contract_version, INGESTION_CONTRACT_VERSION_V2
        ));
    }
    if run_obs.artifact_digest != attestation.predicate.run.artifact_sha256 {
        return Err(format!(
            "Database artifact digest ({}) != attestation ({})",
            run_obs.artifact_digest, attestation.predicate.run.artifact_sha256
        ));
    }
    if run_obs.plan_digest != attestation.predicate.run.plan_sha256 {
        return Err(format!(
            "Database plan digest ({}) != attestation ({})",
            run_obs.plan_digest, attestation.predicate.run.plan_sha256
        ));
    }

    // 6. Verify complete checks match
    if attestation.predicate.checks.len() != check_obs.len() {
        return Err(format!(
            "Attested check count ({}) != database check count ({})",
            attestation.predicate.checks.len(),
            check_obs.len()
        ));
    }

    let db_checks_map: HashMap<String, _> =
        check_obs.iter().map(|c| (c.check_id.clone(), c)).collect();
    let m7_checks_map: HashMap<String, _> =
        run.checks.iter().map(|c| (c.check_id.clone(), c)).collect();

    let attested_check_ids: HashSet<&String> = attestation
        .predicate
        .checks
        .iter()
        .map(|c| &c.check_id)
        .collect();
    let db_check_ids: HashSet<&String> = check_obs.iter().map(|c| &c.check_id).collect();
    if attested_check_ids != db_check_ids {
        return Err("Attested check IDs set does not match database check IDs set".to_string());
    }

    for check in &attestation.predicate.checks {
        let db_c = db_checks_map
            .get(&check.check_id)
            .ok_or_else(|| format!("Attested check {:?} not found in database", check.check_id))?;
        let m7_c = m7_checks_map.get(&check.check_id).ok_or_else(|| {
            format!(
                "Attested check {:?} not found in M7 artifact",
                check.check_id
            )
        })?;

        if check.kind != db_c.kind || check.kind != m7_c.kind {
            return Err(format!(
                "Check {:?} kind mismatch: attested {:?} != db {:?} / m7 {:?}",
                check.check_id, check.kind, db_c.kind, m7_c.kind
            ));
        }
        if check.status != db_c.status || check.status != m7_c.status {
            return Err(format!(
                "Check {:?} status mismatch: attested {:?} != db {:?} / m7 {:?}",
                check.check_id, check.status, db_c.status, m7_c.status
            ));
        }
        if check.mandatory != db_c.mandatory {
            return Err(format!(
                "Check {:?} mandatory mismatch: attested {} != db {}",
                check.check_id, check.mandatory, db_c.mandatory
            ));
        }
        if check.execution_id != db_c.execution_id || check.execution_id != m7_c.execution_id {
            return Err(format!(
                "Check {:?} execution_id mismatch: attested {:?} != db {:?} / m7 {:?}",
                check.check_id, check.execution_id, db_c.execution_id, m7_c.execution_id
            ));
        }
        if check.has_physical_execution != db_c.has_physical_execution {
            return Err(format!(
                "Check {:?} physical flag mismatch: attested {} != db {}",
                check.check_id, check.has_physical_execution, db_c.has_physical_execution
            ));
        }
        if check.reused_execution != db_c.reused_execution
            || check.reused_execution != m7_c.reused_execution
        {
            return Err(format!(
                "Check {:?} reused_execution mismatch: attested {} != db {} / m7 {}",
                check.check_id,
                check.reused_execution,
                db_c.reused_execution,
                m7_c.reused_execution
            ));
        }
    }

    // 7. Verify complete executions match
    if attestation.predicate.executions.len() != executions.len() {
        return Err(format!(
            "Attested execution count ({}) != database execution count ({})",
            attestation.predicate.executions.len(),
            executions.len()
        ));
    }

    let db_execs_map: HashMap<String, _> = executions
        .iter()
        .map(|e| (e.execution_id.clone(), e))
        .collect();

    let attested_exec_ids: HashSet<&String> = attestation
        .predicate
        .executions
        .iter()
        .map(|e| &e.execution_id)
        .collect();
    let db_exec_ids: HashSet<&String> = executions.iter().map(|e| &e.execution_id).collect();
    if attested_exec_ids != db_exec_ids {
        return Err(
            "Attested execution IDs set does not match database execution IDs set".to_string(),
        );
    }

    for exec in &attestation.predicate.executions {
        let db_e = db_execs_map.get(&exec.execution_id).ok_or_else(|| {
            format!(
                "Attested execution {:?} not found in database",
                exec.execution_id
            )
        })?;
        if exec.program != db_e.program {
            return Err(format!(
                "Execution {:?} program mismatch: attested {:?} != db {:?}",
                exec.execution_id, exec.program, db_e.program
            ));
        }
        if exec.argv_digest != db_e.argv_digest {
            return Err(format!(
                "Execution {:?} argv_digest mismatch: attested {:?} != db {:?}",
                exec.execution_id, exec.argv_digest, db_e.argv_digest
            ));
        }
        if exec.cwd != db_e.cwd {
            return Err(format!(
                "Execution {:?} cwd mismatch: attested {:?} != db {:?}",
                exec.execution_id, exec.cwd, db_e.cwd
            ));
        }
        if exec.status != db_e.status {
            return Err(format!(
                "Execution {:?} status mismatch: attested {:?} != db {:?}",
                exec.execution_id, exec.status, db_e.status
            ));
        }
        if exec.exit_code != db_e.exit_code {
            return Err(format!(
                "Execution {:?} exit_code mismatch: attested {:?} != db {:?}",
                exec.execution_id, exec.exit_code, db_e.exit_code
            ));
        }
        if exec.duration_ms != db_e.duration_ms {
            return Err(format!(
                "Execution {:?} duration_ms mismatch: attested {} != db {}",
                exec.execution_id, exec.duration_ms, db_e.duration_ms
            ));
        }
        if exec.stdout_digest != db_e.stdout_digest {
            return Err(format!(
                "Execution {:?} stdout_digest mismatch: attested {:?} != db {:?}",
                exec.execution_id, exec.stdout_digest, db_e.stdout_digest
            ));
        }
        if exec.stderr_digest != db_e.stderr_digest {
            return Err(format!(
                "Execution {:?} stderr_digest mismatch: attested {:?} != db {:?}",
                exec.execution_id, exec.stderr_digest, db_e.stderr_digest
            ));
        }
        if exec.stdout_captured_bytes != db_e.stdout_captured_bytes {
            return Err(format!(
                "Execution {:?} stdout_captured_bytes mismatch: attested {} != db {}",
                exec.execution_id, exec.stdout_captured_bytes, db_e.stdout_captured_bytes
            ));
        }
        if exec.stderr_captured_bytes != db_e.stderr_captured_bytes {
            return Err(format!(
                "Execution {:?} stderr_captured_bytes mismatch: attested {} != db {}",
                exec.execution_id, exec.stderr_captured_bytes, db_e.stderr_captured_bytes
            ));
        }
        if exec.output_truncated != db_e.output_truncated {
            return Err(format!(
                "Execution {:?} output_truncated mismatch: attested {} != db {}",
                exec.execution_id, exec.output_truncated, db_e.output_truncated
            ));
        }
    }

    Ok(AttestationVerificationReport {
        valid: true,
        run_id: run.run_id,
        artifact_sha256: attestation.predicate.run.artifact_sha256.clone(),
        attestation_sha256: computed_attestation_sha256,
        outcome: attestation.predicate.result.outcome,
        assurance: attestation.predicate.result.assurance,
        checks_verified: attestation.predicate.checks.len(),
        executions_verified: attestation.predicate.executions.len(),
        global_history_complete_at_generation: attestation
            .predicate
            .runtime_history
            .global_history_complete_at_generation,
    })
}
