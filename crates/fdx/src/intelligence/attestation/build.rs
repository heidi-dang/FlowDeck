//! Attestation construction and M7/M8 verification evidence binding.

use crate::intelligence::attestation::model::{
    AttestationGenerator, AttestedCheck, AttestedExecution, AttestedPlan, AttestedRunIdentity,
    AttestedUncertainty, AttestedVerificationResult, InTotoDigest, InTotoStatement, InTotoSubject,
    RuntimeHistoryQualification, SourceContext, VerificationAttestation, VerificationPredicateV1,
    FDX_ATTESTATION_PREDICATE_VERSION, FDX_VERIFICATION_PREDICATE_V1_TYPE,
    IN_TOTO_STATEMENT_V1_TYPE,
};
use crate::intelligence::runtime::model::INGESTION_CONTRACT_VERSION_V2;
use crate::intelligence::runtime::query::get_historical_run;
use crate::intelligence::runtime::{compute_plan_digest, sha256_bytes};
use crate::intelligence::verify::model::{CheckExecutionStatus, VerificationRun};
use crate::intelligence::verify::persist::run_artifact_path;
use crate::intelligence::verify::redact::redact_secrets;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

/// Check if a status represents a physical OS process execution.
fn is_physical_status(status: &CheckExecutionStatus) -> bool {
    matches!(
        status,
        CheckExecutionStatus::Passed
            | CheckExecutionStatus::Failed
            | CheckExecutionStatus::TimedOut
            | CheckExecutionStatus::OutputLimitExceeded
    )
}

/// Query global history completeness from runtime_ingestion_state table.
pub fn query_global_history_completeness(conn: &Connection) -> Result<bool, String> {
    let res: Option<String> = conn
        .query_row(
            "SELECT value FROM runtime_ingestion_state WHERE key = 'is_complete'",
            params![],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to query runtime_ingestion_state: {}", e))?;

    Ok(res.as_deref() == Some("true"))
}

/// Validate run_id against path traversal attacks.
pub fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || run_id.contains('/')
        || run_id.contains('\\')
        || run_id.contains("..")
        || run_id.contains('\0')
        || run_id.starts_with('.')
    {
        return Err(format!(
            "invalid run_id: path traversal detected: {:?}",
            run_id
        ));
    }
    Ok(())
}

/// Construct a verifiable in-toto attestation binding exact M7 and qualified M8 evidence.
pub fn build_verification_attestation(
    repo_root: &Path,
    run_id: &str,
    conn: &Connection,
) -> Result<VerificationAttestation, String> {
    validate_run_id(run_id)?;

    // 1. Load exact raw M7 artifact bytes and parse VerificationRun
    let artifact_path = run_artifact_path(repo_root, run_id);
    if !artifact_path.exists() {
        return Err(format!(
            "Run artifact not found at {:?}. Attestation requires an existing persisted M7 verification run.",
            artifact_path
        ));
    }

    let raw_artifact_bytes = fs::read(&artifact_path)
        .map_err(|e| format!("failed to read run artifact {:?}: {}", artifact_path, e))?;
    let exact_artifact_sha256 = sha256_bytes(&raw_artifact_bytes);

    let run: VerificationRun = serde_json::from_slice(&raw_artifact_bytes)
        .map_err(|e| format!("failed to parse run artifact {:?}: {}", artifact_path, e))?;

    if run.run_id != run_id {
        return Err(format!(
            "Run ID mismatch: filename run_id {:?} != artifact run_id {:?}",
            run_id, run.run_id
        ));
    }

    // 2. Fetch qualified M8 runtime observation from SQLite database
    let historical = get_historical_run(conn, run_id)?
        .ok_or_else(|| {
            format!(
                "Run {:?} not found in runtime history database. Attestation requires qualified M8 history. Run 'fdx history reconcile'.",
                run_id
            )
        })?;

    let (run_obs, executions, check_obs) = historical;

    // 3. Verify M8 contract version
    if run_obs.ingestion_contract_version < INGESTION_CONTRACT_VERSION_V2 {
        return Err(format!(
            "Run {:?} has legacy/unqualified ingestion contract version {} (expected version {}). Run 'fdx history reconcile' to qualify exact artifact bytes.",
            run_id, run_obs.ingestion_contract_version, INGESTION_CONTRACT_VERSION_V2
        ));
    }

    // 4. Verify exact artifact digest match
    if run_obs.artifact_digest != exact_artifact_sha256 {
        return Err(format!(
            "Artifact digest mismatch for run {:?}: database recorded {} != exact file hash {}",
            run_id, run_obs.artifact_digest, exact_artifact_sha256
        ));
    }

    // 5. Verify plan digest match
    let computed_plan_digest = compute_plan_digest(&run.plan)?;
    if run_obs.plan_digest != computed_plan_digest {
        return Err(format!(
            "Plan digest mismatch for run {:?}: database recorded {} != computed plan hash {}",
            run_id, run_obs.plan_digest, computed_plan_digest
        ));
    }

    // 6. Verify top-level result match
    if run_obs.outcome != run.outcome {
        return Err(format!(
            "Outcome mismatch for run {:?}: database {:?} != artifact {:?}",
            run_id, run_obs.outcome, run.outcome
        ));
    }
    if run_obs.assurance != run.assurance {
        return Err(format!(
            "Assurance mismatch for run {:?}: database {:?} != artifact {:?}",
            run_id, run_obs.assurance, run.assurance
        ));
    }

    // 7. Verify checks consistency between M7 and M8
    if run.checks.len() != check_obs.len() {
        return Err(format!(
            "Check count mismatch for run {:?}: M7 artifact has {} checks != M8 database has {} check observations",
            run_id, run.checks.len(), check_obs.len()
        ));
    }

    let m8_checks_by_id: HashMap<String, _> =
        check_obs.iter().map(|c| (c.check_id.clone(), c)).collect();

    let m8_execs_by_id: HashMap<String, _> = executions
        .iter()
        .map(|e| (e.execution_id.clone(), e))
        .collect();

    for m7_check in &run.checks {
        let m8_check = m8_checks_by_id.get(&m7_check.check_id).ok_or_else(|| {
            format!(
                "Check {:?} in M7 artifact not found in M8 database check observations",
                m7_check.check_id
            )
        })?;

        if m7_check.status != m8_check.status {
            return Err(format!(
                "Check {:?} status mismatch: M7 artifact {:?} != M8 database {:?}",
                m7_check.check_id, m7_check.status, m8_check.status
            ));
        }
        if m7_check.kind != m8_check.kind {
            return Err(format!(
                "Check {:?} kind mismatch: M7 artifact {:?} != M8 database {:?}",
                m7_check.check_id, m7_check.kind, m8_check.kind
            ));
        }
        if m7_check.execution_id != m8_check.execution_id {
            return Err(format!(
                "Check {:?} execution_id mismatch: M7 artifact {:?} != M8 database {:?}",
                m7_check.check_id, m7_check.execution_id, m8_check.execution_id
            ));
        }
        if m7_check.reused_execution != m8_check.reused_execution {
            return Err(format!(
                "Check {:?} reused_execution mismatch: M7 artifact {} != M8 database {}",
                m7_check.check_id, m7_check.reused_execution, m8_check.reused_execution
            ));
        }

        let is_phys = is_physical_status(&m7_check.status);
        if is_phys != m8_check.has_physical_execution {
            return Err(format!(
                "Check {:?} physicality mismatch: status {:?} implies physical={} but M8 database has {}",
                m7_check.check_id, m7_check.status, is_phys, m8_check.has_physical_execution
            ));
        }

        if is_phys && !m8_execs_by_id.contains_key(&m7_check.execution_id) {
            return Err(format!(
                "Physical check {:?} references execution_id {:?} which is missing from M8 runtime_executions table",
                m7_check.check_id, m7_check.execution_id
            ));
        }
        if !is_phys && m8_execs_by_id.contains_key(&m7_check.execution_id) {
            return Err(format!(
                "Non-physical check {:?} with status {:?} has an invalid physical execution row {:?} in M8 runtime_executions table",
                m7_check.check_id, m7_check.status, m7_check.execution_id
            ));
        }
    }

    // 8. Build and sort deterministic checks
    let mut attested_checks: Vec<AttestedCheck> = run
        .checks
        .iter()
        .map(|c| {
            let m8_check = m8_checks_by_id.get(&c.check_id).unwrap();
            AttestedCheck {
                check_id: c.check_id.clone(),
                kind: c.kind,
                status: c.status,
                mandatory: m8_check.mandatory,
                execution_id: c.execution_id.clone(),
                has_physical_execution: m8_check.has_physical_execution,
                reused_execution: c.reused_execution,
            }
        })
        .collect();
    attested_checks.sort_by(|a, b| a.check_id.cmp(&b.check_id));

    // 9. Build and sort deterministic executions
    let mut attested_executions: Vec<AttestedExecution> = executions
        .iter()
        .map(|e| AttestedExecution {
            execution_id: e.execution_id.clone(),
            program: e.program.clone(),
            argv_digest: e.argv_digest.clone(),
            cwd: e.cwd.clone(),
            status: e.status,
            exit_code: e.exit_code,
            duration_ms: e.duration_ms,
            stdout_digest: e.stdout_digest.clone().unwrap_or_default(),
            stderr_digest: e.stderr_digest.clone().unwrap_or_default(),
            stdout_captured_bytes: e.stdout_captured_bytes,
            stderr_captured_bytes: e.stderr_captured_bytes,
            output_truncated: e.output_truncated,
        })
        .collect();
    attested_executions.sort_by(|a, b| a.execution_id.cmp(&b.execution_id));

    // 10. Build and sort deterministic uncertainties
    let mut uncertainty_map: BTreeMap<
        (String, String, Option<String>, String),
        AttestedUncertainty,
    > = BTreeMap::new();

    for u in run.uncertainty.iter().chain(run.plan.uncertainty.iter()) {
        let code = u.code().to_string();
        let trigger = format!("{:?}", u);
        let redacted_msg = redact_secrets(&trigger);
        let key = (code.clone(), trigger.clone(), None, redacted_msg.clone());
        uncertainty_map
            .entry(key)
            .or_insert_with(|| AttestedUncertainty {
                code,
                trigger,
                message: redacted_msg,
                target: None,
            });
    }

    let attested_uncertainties: Vec<AttestedUncertainty> = uncertainty_map.into_values().collect();

    // 11. Query global history status
    let global_history_complete = query_global_history_completeness(conn)?;

    // 12. Calculate planned check counts
    let total_obligations = run.plan.selected_checks.len();
    let mandatory_obligations = run
        .plan
        .selected_checks
        .iter()
        .filter(|c| c.mandatory)
        .count();
    let advisory_obligations = total_obligations - mandatory_obligations;

    // 13. Construct Predicate v1
    let predicate = VerificationPredicateV1 {
        schema_version: FDX_ATTESTATION_PREDICATE_VERSION,
        run: AttestedRunIdentity {
            run_id: run.run_id.clone(),
            artifact_sha256: exact_artifact_sha256.clone(),
            plan_sha256: computed_plan_digest.clone(),
            executed_at_ms: run.executed_at_ms,
            duration_ms: run.duration_ms,
        },
        plan: AttestedPlan {
            plan_id: format!(
                "plan:{}",
                &computed_plan_digest[..16.min(computed_plan_digest.len())]
            ),
            plan_sha256: computed_plan_digest,
            total_obligations,
            mandatory_obligations,
            advisory_obligations,
        },
        result: AttestedVerificationResult {
            outcome: run.outcome,
            assurance: run.assurance,
            unresolved_obligation_count: run.plan.unresolved_obligations.len(),
        },
        executions: attested_executions,
        checks: attested_checks,
        uncertainty: attested_uncertainties,
        runtime_history: RuntimeHistoryQualification {
            run_contract_version: INGESTION_CONTRACT_VERSION_V2,
            run_qualified: true,
            global_history_complete,
        },
        source_context: SourceContext {
            base_ref: run.base.clone(),
            head_ref: run.head.clone(),
            changed_files_count: run.plan.changed.len(),
            impacted_targets_count: run.plan.impacted_targets.len(),
            workspace_clean: run.base.is_some() && run.head.is_some(),
        },
        generator: AttestationGenerator {
            name: "fdx".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
    };

    // 14. Construct in-toto Statement v1 envelope
    let statement = InTotoStatement {
        statement_type: IN_TOTO_STATEMENT_V1_TYPE.to_string(),
        subject: vec![InTotoSubject {
            name: format!("fdx-verification-run:{}", run.run_id),
            digest: InTotoDigest {
                sha256: exact_artifact_sha256,
            },
        }],
        predicate_type: FDX_VERIFICATION_PREDICATE_V1_TYPE.to_string(),
        predicate,
    };

    Ok(statement)
}
