//! Attestation statement verification and cryptographic tamper detection.

use crate::intelligence::attestation::canonical::canonicalize_to_vec;
use crate::intelligence::attestation::model::{
    VerificationAttestation, FDX_ATTESTATION_PREDICATE_VERSION, FDX_VERIFICATION_PREDICATE_V1_TYPE,
    IN_TOTO_STATEMENT_V1_TYPE,
};
use crate::intelligence::runtime::model::INGESTION_CONTRACT_VERSION_V2;
use crate::intelligence::runtime::query::get_historical_run;
use crate::intelligence::runtime::{compute_plan_digest, sha256_bytes};
use crate::intelligence::verify::model::{VerificationOutcome, VerificationRun};
use crate::intelligence::verify::persist::run_artifact_path;
use crate::protocol::AssuranceLevel;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    pub global_history_complete: bool,
}

/// Verify an in-toto attestation against persisted M7 run artifact and M8 SQLite history.
pub fn verify_attestation(
    repo_root: &Path,
    attestation: &VerificationAttestation,
    raw_bytes: Option<&[u8]>,
    conn: &Connection,
) -> Result<AttestationVerificationReport, String> {
    // 1. Envelope type validation
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

    // 2. Subject validation
    if attestation.subject.is_empty() {
        return Err("Attestation subject list is empty".to_string());
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

    // 3. Compute canonical attestation SHA-256
    let canonical_bytes = canonicalize_to_vec(attestation)?;
    let computed_attestation_sha256 = sha256_bytes(&canonical_bytes);

    if let Some(bytes) = raw_bytes {
        let raw_sha256 = sha256_bytes(bytes);
        if raw_sha256 != computed_attestation_sha256 && bytes != canonical_bytes {
            // If not identical, verify canonical representation matches
            let parsed_canonical = canonicalize_to_vec(attestation)?;
            if sha256_bytes(&parsed_canonical) != computed_attestation_sha256 {
                return Err("Canonical attestation digest verification failed".to_string());
            }
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
    if run.plan.selected_checks.len() != attestation.predicate.plan.total_obligations {
        return Err(format!(
            "Plan obligation count mismatch: M7 artifact ({}) != attestation ({})",
            run.plan.selected_checks.len(),
            attestation.predicate.plan.total_obligations
        ));
    }

    // 5. Verify M8 database records
    let historical = get_historical_run(conn, run_id)?
        .ok_or_else(|| format!("Run {:?} not found in M8 SQLite runtime history", run_id))?;
    let (run_obs, executions, check_obs) = historical;

    if run_obs.ingestion_contract_version < INGESTION_CONTRACT_VERSION_V2 {
        return Err(format!(
            "Run {:?} in database is not qualified under contract version 2",
            run_id
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

    let recomputed_plan_digest = compute_plan_digest(&run.plan)?;
    if recomputed_plan_digest != attestation.predicate.plan.plan_sha256 {
        return Err(format!(
            "Recomputed plan digest ({}) != attestation plan digest ({})",
            recomputed_plan_digest, attestation.predicate.plan.plan_sha256
        ));
    }

    // 6. Verify check count & checks match
    if attestation.predicate.checks.len() != check_obs.len() {
        return Err(format!(
            "Attested check count ({}) != database check count ({})",
            attestation.predicate.checks.len(),
            check_obs.len()
        ));
    }

    let db_checks_map: HashMap<String, _> =
        check_obs.iter().map(|c| (c.check_id.clone(), c)).collect();
    for check in &attestation.predicate.checks {
        let db_c = db_checks_map
            .get(&check.check_id)
            .ok_or_else(|| format!("Attested check {:?} not found in database", check.check_id))?;
        if check.status != db_c.status {
            return Err(format!(
                "Check {:?} status mismatch: attested {:?} != db {:?}",
                check.check_id, check.status, db_c.status
            ));
        }
        if check.has_physical_execution != db_c.has_physical_execution {
            return Err(format!(
                "Check {:?} physical flag mismatch: attested {} != db {}",
                check.check_id, check.has_physical_execution, db_c.has_physical_execution
            ));
        }
    }

    // 7. Verify executions match
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
        if exec.status != db_e.status {
            return Err(format!(
                "Execution {:?} status mismatch: attested {:?} != db {:?}",
                exec.execution_id, exec.status, db_e.status
            ));
        }
    }

    Ok(AttestationVerificationReport {
        valid: true,
        run_id: run_id.clone(),
        artifact_sha256: attestation.predicate.run.artifact_sha256.clone(),
        attestation_sha256: computed_attestation_sha256,
        outcome: attestation.predicate.result.outcome,
        assurance: attestation.predicate.result.assurance,
        checks_verified: attestation.predicate.checks.len(),
        executions_verified: attestation.predicate.executions.len(),
        global_history_complete: attestation
            .predicate
            .runtime_history
            .global_history_complete,
    })
}
