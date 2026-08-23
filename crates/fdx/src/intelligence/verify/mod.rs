//! Milestone 7: Verification Executor.
//!
//! Provides bounded, reproducible execution of verification plans with cryptographic provenance,
//! strict path containment, secret redaction, and deterministic outcome aggregation.

pub mod action;
pub mod aggregate;
pub mod executor;
pub mod explain;
pub mod identity;
pub mod model;
pub mod persist;
pub mod process;
pub mod redact;
pub mod resolve;

pub use action::{ConcreteInvocation, ExecutionAction, KnownJsTestRunner};
pub use aggregate::{aggregate_outcome, propagate_assurance};
pub use executor::{execute_verification_plan, VerificationExecutorOptions};
pub use explain::format_verification_run_text;
pub use identity::{generate_execution_id, generate_unique_run_id};
pub use model::{
    CheckExecutionResult, CheckExecutionStatus, PersistenceStatus, VerificationOutcome,
    VerificationRun,
};
pub use persist::{load_verification_run, persist_verification_run, run_artifact_path, runs_dir};
pub use process::{execute_bounded_command, ProcessBounds, RawProcessOutcome};
pub use redact::redact_secrets;
pub use resolve::{detect_package_manager, resolve_check_action, validate_and_contain_path};
