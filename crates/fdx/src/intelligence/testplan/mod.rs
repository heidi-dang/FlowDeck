//! Milestone 6: Test Mapping and Verification Planner.

pub mod bounds;
pub mod discover;
pub mod explain;
pub mod freshness;
pub mod mapping;
pub mod model;
pub mod planner;
pub mod policy;

pub use model::{PlannedCheck, SelectionReason, VerificationCheckKind, VerificationPlan};
pub use planner::plan_verification;
