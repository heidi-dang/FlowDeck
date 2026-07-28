//! Output formatting for PR Monitor CLI commands.

use crate::pr_monitor::state::{RepairExitState, RepairState};
use serde::Serialize;

#[derive(Serialize)]
pub struct StatusOutput {
    pub running: bool,
    pub repo: Option<String>,
    pub pr: Option<i64>,
    pub mode: String,
    pub active_repairs: usize,
}

pub fn format_status_json(status: &StatusOutput) -> String {
    serde_json::to_string_pretty(status).unwrap_or_default()
}

pub fn format_status_text(status: &StatusOutput) -> String {
    let mut lines = Vec::new();
    lines.push("PR Monitor Status".to_string());
    lines.push("".to_string());
    lines.push(format!("Running: {}", status.running));
    if let Some(ref repo) = status.repo {
        lines.push(format!("Repo: {}", repo));
    }
    if let Some(pr) = status.pr {
        lines.push(format!("PR: #{}", pr));
    }
    lines.push(format!("Mode: {}", status.mode));
    lines.push(format!("Active repairs: {}", status.active_repairs));
    lines.join("\n")
}

pub fn format_state(state: &RepairState) -> &str {
    match state {
        RepairState::Idle => "IDLE",
        RepairState::FailureDetected => "FAILURE_DETECTED",
        RepairState::Claimed => "CLAIMED",
        RepairState::LogsCollected => "LOGS_COLLECTED",
        RepairState::Classified => "CLASSIFIED",
        RepairState::Repairing => "REPAIRING",
        RepairState::LocalValidation => "LOCAL_VALIDATION",
        RepairState::Pushing => "PUSHING",
        RepairState::WaitingForNewCi => "WAITING_FOR_NEW_CI",
        RepairState::Green => "GREEN",
    }
}

pub fn format_exit_state(state: &RepairExitState) -> &str {
    match state {
        RepairExitState::Blocked => "BLOCKED",
        RepairExitState::StaleHead => "STALE_HEAD",
        RepairExitState::MaxAttemptsReached => "MAX_ATTEMPTS_REACHED",
        RepairExitState::InfrastructureFailure => "INFRASTRUCTURE_FAILURE",
        RepairExitState::ModelFailed => "MODEL_FAILED",
        RepairExitState::LocalValidationFailed => "LOCAL_VALIDATION_FAILED",
    }
}
