//! Milestone 8: Runtime Evidence & Historical Verification Intelligence.
//!
//! Provides durable, transactional storage, crash-safe reconciliation, and queryable historical statistics
//! for executed M7 verification runs without semantic promotion or test selection modification.

pub mod cooccurrence;
pub mod digest;
pub mod ingest;
pub mod model;
pub mod query;
pub mod reconcile;
pub mod schema;
pub mod stats;

pub use cooccurrence::{query_check_cooccurrences, CoOccurrenceObservation};
pub use digest::{compute_argv_digest, compute_plan_digest, sha256_bytes};
pub use ingest::{
    ingest_verification_artifact, is_physical_process_execution, MAX_RUNTIME_ARTIFACT_BYTES,
};
pub use model::{
    CheckHistoryStats, HistoricalFlakeSignal, HistoryReconciliationReport,
    RuntimeChangeObservation, RuntimeCheckObservation, RuntimeExecutionObservation,
    RuntimeIngestResult, RuntimeRunObservation, INGESTION_CONTRACT_VERSION_V2,
};
pub use query::{get_historical_run, list_historical_runs};
pub use reconcile::reconcile_runs_directory;
pub use schema::{MIGRATE_V5_TO_V6_SQL, MIGRATE_V6_TO_V7_SQL, RUNTIME_SCHEMA_VERSION};
pub use stats::{compute_percentiles, query_check_statistics};
