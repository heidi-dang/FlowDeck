//! Milestone 10: Shadow Calibration.
//!
//! Measures how accurately FDX's M6 verification planner selects checks by executing
//! a broader independent shadow reference set and comparing choices against observed outcomes.
//!
//! Invariant: Shadow calibration data is measurement-only and NEVER alters production
//! verification planning, assurance, or verification truth.

pub mod evaluate;
pub mod explain;
pub mod model;
pub mod persist;
pub mod policy;
pub mod query;
pub mod reference;
pub mod schema;

pub use evaluate::{
    compute_calibration_record_digest, run_calibration, run_calibration_with_source_artifact,
};
pub use explain::{format_calibration_run_text, format_calibration_stats_text};
pub use model::*;
pub use persist::persist_calibration_run;
pub use policy::{compute_policy_digest, generate_calibration_id};
pub use query::{get_calibration_run, get_calibration_stats, list_calibration_runs};
pub use reference::construct_shadow_reference_set;
