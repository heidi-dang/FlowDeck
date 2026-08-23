//! Execution and run identity generation.
//!
//! Provides unique, collision-resistant identifiers for verification runs and process executions.

use crate::intelligence::semantic::provider::sha256_hex;
use crate::intelligence::testplan::model::VerificationPlan;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);
static EXEC_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Generate a unique execution identity for a process invocation.
pub fn generate_execution_id(program: &str, started_at_ms: u64) -> String {
    let count = EXEC_COUNTER.fetch_add(1, Ordering::SeqCst);
    let prog_name = Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("proc");
    format!("exec_{}_{}_{}", started_at_ms, prog_name, count)
}

/// Generate a cryptographically unique run ID for a verification run.
pub fn generate_unique_run_id(plan: &VerificationPlan, now_override_ms: Option<u64>) -> String {
    let now_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let count = RUN_COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    let plan_json = serde_json::to_string(plan).unwrap_or_default();

    let entropy = format!("{}:{}:{}:{}:{}", now_nanos, count, pid, plan_json, count);
    let hash = sha256_hex(entropy.as_bytes());

    let millis = now_override_ms.unwrap_or((now_nanos / 1_000_000) as u64);
    format!("run_{}_{}", millis, &hash[..16])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intelligence::testplan::model::VerificationPlan;
    use std::collections::HashSet;

    fn make_test_plan() -> VerificationPlan {
        VerificationPlan {
            assurance: crate::protocol::AssuranceLevel::Exact,
            changed: vec![],
            impacted_targets: vec![],
            selected_checks: vec![],
            uncertainty: vec![],
            unresolved_obligations: vec![],
        }
    }

    #[test]
    fn test_run_id_unique_across_parallel_invocations() {
        let plan = make_test_plan();
        let count = 100;
        let mut ids = HashSet::new();
        for _ in 0..count {
            let id = generate_unique_run_id(&plan, None);
            assert!(ids.insert(id), "duplicate run id generated");
        }
        assert_eq!(ids.len(), count);
    }

    #[test]
    fn test_run_id_unique_with_same_timestamp_and_plan() {
        let plan = make_test_plan();
        let fixed_ts = 1700000000000;
        let id1 = generate_unique_run_id(&plan, Some(fixed_ts));
        let id2 = generate_unique_run_id(&plan, Some(fixed_ts));
        assert_ne!(id1, id2);
        assert!(id1.starts_with("run_1700000000000_"));
        assert!(id2.starts_with("run_1700000000000_"));
    }
}
