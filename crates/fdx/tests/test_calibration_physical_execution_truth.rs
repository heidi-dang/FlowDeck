use fdx::intelligence::calibration::run_calibration;
use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use tempfile::tempdir;

fn check(id: &str) -> PlannedCheck {
    PlannedCheck {
        check_id: id.to_string(),
        display_name: format!("display {id}"),
        kind: VerificationCheckKind::IntegrationTest,
        scope: "pkg:cargo:core".to_string(),
        reason: "selected".to_string(),
        selection: SelectionReason::Evidence,
        strength: EvidenceStrength::Precise,
        evidence_path: None,
        evidence_refs: vec![],
        widening_reason: None,
        mandatory: false,
    }
}

fn result(
    check: &PlannedCheck,
    status: CheckExecutionStatus,
    execution_id: &str,
    reused_execution: bool,
    duration_ms: u64,
) -> CheckExecutionResult {
    CheckExecutionResult {
        check_id: check.check_id.clone(),
        kind: check.kind,
        status,
        execution_id: execution_id.to_string(),
        reused_execution,
        command: vec!["echo".to_string(), "stable".to_string()],
        cwd: ".".to_string(),
        exit_code: Some(0),
        signal: None,
        duration_ms,
        stdout_digest: Some("stdout".to_string()),
        stderr_digest: None,
        stdout_excerpt: None,
        stderr_excerpt: None,
        stdout_captured_bytes: 0,
        stderr_captured_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        started_at_ms: 1,
        reason: Some("diagnostic".to_string()),
    }
}

fn source_run(checks: Vec<PlannedCheck>, results: Vec<CheckExecutionResult>) -> VerificationRun {
    VerificationRun {
        run_id: "source-physical-truth".to_string(),
        plan: VerificationPlan {
            assurance: AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: checks,
            uncertainty: vec![],
            unresolved_obligations: vec![],
        },
        outcome: VerificationOutcome::Incomplete,
        assurance: AssuranceLevel::Exact,
        checks: results,
        uncertainty: vec![],
        base: None,
        head: None,
        persistence_status: PersistenceStatus::NotRequested,
        executed_at_ms: 1,
        duration_ms: 1,
    }
}

#[test]
fn unsupported_and_spawn_failed_candidates_never_create_physical_executions() {
    let unsupported = check("check:unsupported");
    let spawn_failed = check("check:spawn-failed");
    let source = source_run(
        vec![unsupported.clone(), spawn_failed.clone()],
        vec![
            result(
                &unsupported,
                CheckExecutionStatus::Unsupported,
                "unsupported-exec",
                false,
                9,
            ),
            result(
                &spawn_failed,
                CheckExecutionStatus::SpawnFailed,
                "spawn-failed-exec",
                false,
                11,
            ),
        ],
    );

    let root = tempdir().unwrap();
    let calibration = run_calibration(root.path(), &source, &Default::default()).unwrap();
    assert_eq!(calibration.checks.len(), 2);
    assert!(calibration
        .checks
        .iter()
        .all(|observation| !observation.has_physical_execution));
    assert!(calibration
        .checks
        .iter()
        .all(|observation| observation.execution_id.is_none()));
    assert!(calibration.executions.is_empty());
    assert_eq!(calibration.metrics.candidate_physical_execution_count, 0);
}

#[test]
fn shared_candidate_execution_creates_one_process_row_and_one_duration_charge() {
    let first = check("check:shared-first");
    let second = check("check:shared-second");
    let third = check("check:shared-third");
    let source = source_run(
        vec![first.clone(), second.clone(), third.clone()],
        vec![
            result(&first, CheckExecutionStatus::Passed, "shared", false, 17),
            result(&second, CheckExecutionStatus::Passed, "shared", true, 17),
            result(&third, CheckExecutionStatus::Passed, "shared", true, 17),
        ],
    );

    let root = tempdir().unwrap();
    let calibration = run_calibration(root.path(), &source, &Default::default()).unwrap();
    assert_eq!(calibration.checks.len(), 3);
    assert_eq!(calibration.executions.len(), 1);
    assert_eq!(calibration.metrics.candidate_physical_execution_count, 1);
    assert_eq!(calibration.metrics.candidate_execution_duration_ms, 17);
    assert_eq!(calibration.metrics.shadow_reference_duration_ms, 17);
    assert!(calibration
        .checks
        .iter()
        .all(|observation| observation.execution_id.as_deref() == Some("candidate_shared")));
    assert_eq!(
        calibration
            .checks
            .iter()
            .filter(|observation| observation.reused_execution)
            .count(),
        2
    );
}

#[test]
fn missing_selected_source_result_fails_calibration_without_shadow_reinterpretation() {
    let present = check("check:present");
    let missing = check("check:missing");
    let source = source_run(
        vec![present.clone(), missing],
        vec![result(
            &present,
            CheckExecutionStatus::Passed,
            "present-exec",
            false,
            1,
        )],
    );
    let root = tempdir().unwrap();
    let error = run_calibration(root.path(), &source, &Default::default()).unwrap_err();
    assert!(error.contains("lacks a result for candidate check"));
}
