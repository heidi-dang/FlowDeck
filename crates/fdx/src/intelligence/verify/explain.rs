//! Verification run human-readable text output formatting.

use crate::intelligence::verify::model::{
    CheckExecutionStatus, VerificationOutcome, VerificationRun,
};

/// Format a VerificationRun into human-readable summary text.
pub fn format_verification_run_text(run: &VerificationRun) -> String {
    let mut out = String::new();

    out.push_str(&format!("Verification Run: {}\n", run.run_id));
    out.push_str(&format!(
        "Outcome: {} | Assurance: {:?}\n",
        match run.outcome {
            VerificationOutcome::Passed => "PASSED",
            VerificationOutcome::Failed => "FAILED",
            VerificationOutcome::Incomplete => "INCOMPLETE",
        },
        run.assurance
    ));
    out.push_str(&format!(
        "Duration: {}ms | Checks Executed: {}\n",
        run.duration_ms,
        run.checks.len()
    ));

    out.push_str("\n--- Check Results ---\n");
    for check in &run.checks {
        let status_str = match check.status {
            CheckExecutionStatus::Passed => "PASS",
            CheckExecutionStatus::Failed => "FAIL",
            CheckExecutionStatus::TimedOut => "TIMEOUT",
            CheckExecutionStatus::SpawnFailed => "SPAWN_FAILED",
            CheckExecutionStatus::Unsupported => "UNSUPPORTED",
            CheckExecutionStatus::Skipped => "SKIPPED",
            CheckExecutionStatus::Cancelled => "CANCELLED",
            CheckExecutionStatus::Pending => "PENDING",
            CheckExecutionStatus::Running => "RUNNING",
        };

        out.push_str(&format!(
            "[{}] {} ({}ms)\n",
            status_str, check.check_id, check.duration_ms
        ));

        if !check.command.is_empty() {
            out.push_str(&format!("  Command: {}\n", check.command.join(" ")));
            out.push_str(&format!("  CWD: {}\n", check.cwd));
        }
        if let Some(code) = check.exit_code {
            out.push_str(&format!("  Exit Code: {}\n", code));
        }
        if let Some(ref sig) = check.signal {
            out.push_str(&format!("  Signal: {}\n", sig));
        }
        if let Some(ref reason) = check.reason {
            out.push_str(&format!("  Reason: {}\n", reason));
        }
        if let Some(ref err) = check.stderr_excerpt {
            if !err.is_empty() {
                out.push_str(&format!(
                    "  Stderr Excerpt:\n    {}\n",
                    err.replace('\n', "\n    ")
                ));
            }
        }
    }

    if !run.uncertainty.is_empty() {
        out.push_str("\n--- Uncertainties ---\n");
        for u in &run.uncertainty {
            out.push_str(&format!("- {:?}\n", u));
        }
    }

    out
}
