//! State types for the PR Monitor — mirrors TypeScript types.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RepairState {
    Idle,
    FailureDetected,
    Claimed,
    LogsCollected,
    Classified,
    Repairing,
    LocalValidation,
    Pushing,
    WaitingForNewCi,
    Green,
}

impl std::fmt::Display for RepairState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "IDLE"),
            Self::FailureDetected => write!(f, "FAILURE_DETECTED"),
            Self::Claimed => write!(f, "CLAIMED"),
            Self::LogsCollected => write!(f, "LOGS_COLLECTED"),
            Self::Classified => write!(f, "CLASSIFIED"),
            Self::Repairing => write!(f, "REPAIRING"),
            Self::LocalValidation => write!(f, "LOCAL_VALIDATION"),
            Self::Pushing => write!(f, "PUSHING"),
            Self::WaitingForNewCi => write!(f, "WAITING_FOR_NEW_CI"),
            Self::Green => write!(f, "GREEN"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RepairExitState {
    Blocked,
    StaleHead,
    MaxAttemptsReached,
    InfrastructureFailure,
    ModelFailed,
    LocalValidationFailed,
}

impl std::fmt::Display for RepairExitState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Blocked => write!(f, "BLOCKED"),
            Self::StaleHead => write!(f, "STALE_HEAD"),
            Self::MaxAttemptsReached => write!(f, "MAX_ATTEMPTS_REACHED"),
            Self::InfrastructureFailure => write!(f, "INFRASTRUCTURE_FAILURE"),
            Self::ModelFailed => write!(f, "MODEL_FAILED"),
            Self::LocalValidationFailed => write!(f, "LOCAL_VALIDATION_FAILED"),
        }
    }
}
