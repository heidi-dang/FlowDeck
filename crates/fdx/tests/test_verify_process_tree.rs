use fdx::intelligence::testplan::model::{
    PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan,
};
use fdx::intelligence::verify::model::{CheckExecutionStatus, VerificationOutcome};
use fdx::intelligence::verify::process::ProcessBounds;
use fdx::intelligence::verify::{execute_verification_plan, VerificationExecutorOptions};
use fdx::protocol::{AssuranceLevel, EvidenceStrength};
use std::time::Duration;
use tempfile::tempdir;

#[test]
fn test_timeout_cleans_up_process_tree_and_descendants() {
    let dir = tempdir().unwrap();
    let pid_file = dir.path().join("child.pid");
    let pid_file_str = pid_file.to_string_lossy();

    let node_script = format!(
        "const cp = require('child_process'); const fs = require('fs'); const child = cp.spawn(process.execPath, ['-e', 'require(\"fs\").writeFileSync(\"{}\", String(process.pid)); setInterval(() => {{}}, 1000);'], {{ detached: false, stdio: 'ignore' }}); setInterval(() => {{}}, 1000);",
        pid_file_str
    );

    let pkg_json = dir.path().join("package.json");
    let pkg_val = serde_json::json!({
        "name": "tree-pkg",
        "packageManager": "npm@10.0.0",
        "scripts": {
            "test": format!("node -e \"{}\"", node_script)
        }
    });
    std::fs::write(&pkg_json, pkg_val.to_string()).unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "check:pkg:npm:.:test".to_string(),
            display_name: "tree test".to_string(),
            kind: VerificationCheckKind::UnitTest,
            scope: "pkg:npm:.".to_string(),
            reason: "test".to_string(),
            selection: SelectionReason::MandatoryCheck,
            strength: EvidenceStrength::Precise,
            evidence_path: None,
            evidence_refs: vec![],
            widening_reason: None,
            mandatory: true,
        }],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        bounds: ProcessBounds {
            timeout: Duration::from_millis(500),
            max_stdout_bytes: 1024,
            max_stderr_bytes: 1024,
            tail_limit_bytes: 512,
        },
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Incomplete);
    assert_eq!(run.checks[0].status, CheckExecutionStatus::TimedOut);

    // Wait a brief moment to ensure cleanup completed
    std::thread::sleep(Duration::from_millis(200));

    // If pid_file was created, verify that descendant process was reaped
    if pid_file.exists() {
        if let Ok(pid_str) = std::fs::read_to_string(&pid_file) {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                #[cfg(unix)]
                {
                    // kill(pid, 0) returns -1 if process is dead
                    let alive = unsafe { libc::kill(pid, 0) == 0 };
                    assert!(
                        !alive,
                        "grandchild process {} is still running after timeout",
                        pid
                    );
                }
            }
        }
    }
}

#[test]
fn test_output_overflow_cleans_up_process_tree_and_descendants() {
    let dir = tempdir().unwrap();
    let pid_file = dir.path().join("child_overflow.pid");
    let pid_file_str = pid_file.to_string_lossy();

    let node_script = format!(
        "const cp = require('child_process'); const fs = require('fs'); const child = cp.spawn(process.execPath, ['-e', 'require(\"fs\").writeFileSync(\"{}\", String(process.pid)); setInterval(() => {{}}, 1000);'], {{ detached: false, stdio: 'ignore' }}); setInterval(() => {{ process.stdout.write('A'.repeat(5000)); }}, 10);",
        pid_file_str
    );

    let pkg_json = dir.path().join("package.json");
    let pkg_val = serde_json::json!({
        "name": "overflow-tree-pkg",
        "packageManager": "npm@10.0.0",
        "scripts": {
            "test": format!("node -e \"{}\"", node_script)
        }
    });
    std::fs::write(&pkg_json, pkg_val.to_string()).unwrap();

    let plan = VerificationPlan {
        assurance: AssuranceLevel::Exact,
        changed: vec![],
        impacted_targets: vec![],
        selected_checks: vec![PlannedCheck {
            check_id: "check:pkg:npm:.:test".to_string(),
            display_name: "overflow tree test".to_string(),
            kind: VerificationCheckKind::UnitTest,
            scope: "pkg:npm:.".to_string(),
            reason: "test".to_string(),
            selection: SelectionReason::MandatoryCheck,
            strength: EvidenceStrength::Precise,
            evidence_path: None,
            evidence_refs: vec![],
            widening_reason: None,
            mandatory: true,
        }],
        uncertainty: vec![],
        unresolved_obligations: vec![],
    };

    let options = VerificationExecutorOptions {
        bounds: ProcessBounds {
            timeout: Duration::from_secs(10),
            max_stdout_bytes: 1024,
            max_stderr_bytes: 1024,
            tail_limit_bytes: 512,
        },
        persist: false,
        ..Default::default()
    };

    let run = execute_verification_plan(dir.path(), &plan, &options).unwrap();
    assert_eq!(run.outcome, VerificationOutcome::Incomplete);
    assert_eq!(
        run.checks[0].status,
        CheckExecutionStatus::OutputLimitExceeded
    );

    // Wait a brief moment to ensure cleanup completed
    std::thread::sleep(Duration::from_millis(200));

    // If pid_file was created, verify that descendant process was reaped
    if pid_file.exists() {
        if let Ok(pid_str) = std::fs::read_to_string(&pid_file) {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                #[cfg(unix)]
                {
                    let alive = unsafe { libc::kill(pid, 0) == 0 };
                    assert!(
                        !alive,
                        "grandchild process {} is still running after output limit termination",
                        pid
                    );
                }
            }
        }
    }
}
