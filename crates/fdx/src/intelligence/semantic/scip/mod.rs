//! SCIP ingestion stack: model, bounded decoder, and provider adapters.
//!
//! The generic SCIP parsing path (model + decoder) is shared by every adapter.
//! Adapters only own discovery, command construction, workspace/config scope,
//! output location and fingerprinting (scip/ts.rs, scip/rust.rs).

pub mod decoder;
pub mod model;
pub mod rust;
pub mod ts;

use crate::intelligence::semantic::provider::run_bounded_process;
use std::path::Path;
use std::time::Duration;

/// Canonical SCIP protocol version this build parses (scip.proto 0.1.0).
pub const SCIP_SCHEMA_VERSION: &str = "0.1.0";

/// Probe an executable's version by running it with `--version` (bounded).
/// Returns the first non-empty line trimmed, or None when the probe fails.
///
/// The probe is itself bounded (10s, 64KiB output caps) so a broken
/// executable cannot hang FDX.
pub fn probe_version(exec: &Path, args_prefix: &[String]) -> Option<String> {
    let mut args = args_prefix.to_vec();
    args.push("--version".to_string());
    let outcome = match run_bounded_process(
        exec,
        &args,
        Path::new("."),
        Duration::from_secs(10),
        64 * 1024,
        64 * 1024,
    ) {
        Ok(o) => o,
        Err(_) => return None,
    };
    if outcome.exit_code != Some(0) {
        return None;
    }
    outcome
        .stderr_tail
        .lines()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
