/**
 * Contract-alignment fixture: the doc-vocabulary parity baseline.
 *
 * Captures the canonical vocabulary the routing documentation (sections 4-10)
 * specifies, so the parity test can assert that the executable contracts
 * (TASK_CLASSES, EXECUTION_STRATEGIES, MODEL_TIERS, LATENCY_CLASSES,
 * delegation reasons, HIGH_RISK_FLOOR, requiredReviewers type) match the doc.
 * If a vocabulary value changes, this fixture must change with it, and the
 * doc must be updated in the same commit.
 */

/** Canonical task taxonomy (document section 4.1) — 17 values. */
export const FIXTURE_TASK_CLASSES = [
  "trivial_edit",
  "documentation",
  "read_only_question",
  "repository_audit",
  "local_bug",
  "cross_module_feature",
  "ci_failure",
  "build_package_failure",
  "release_failure",
  "database_migration",
  "concurrency_failure",
  "security_review",
  "performance_work",
  "ui_feature",
  "production_incident",
  "recovery_resume",
  "unknown",
] as const;

/** Canonical execution strategies (document section 6.1) — 9 values. */
export const FIXTURE_EXECUTION_STRATEGIES = [
  "fast_direct",
  "direct_verified",
  "explore_then_execute",
  "planned_execution",
  "parallel_implementation",
  "root_cause_repair",
  "audit_only",
  "repair_and_independent_audit",
  "recovery_resume",
] as const;

/** Ordered model tiers (document section 10) — weakest to strongest. */
export const FIXTURE_MODEL_TIERS = ["small_fast", "general_coding", "strong_reasoning"] as const;

/** Latency classes (document section 7.1) — 3 buckets. */
export const FIXTURE_LATENCY_CLASSES = ["instant", "fast", "slow"] as const;

/** Allowed delegation reasons (document section 8.2). */
export const FIXTURE_DELEGATION_REASONS = [
  "explicit_user_request",
  "independent_ownership",
  "specialist_expertise",
  "independent_audit",
  "direct_discovery_failed",
  "multi_domain",
] as const;

/** Rejected delegation reasons (document section 8.3). */
export const FIXTURE_REJECTED_DELEGATION_REASONS = [
  "rejected_trivial",
  "rejected_overlap",
  "rejected_no_advantage",
  "rejected_cost",
] as const;

/** Universal high-risk floor (document section 5.5). */
export const FIXTURE_HIGH_RISK_FLOOR = 70;

/** StrategyPolicy.requiredReviewers is a count (number), not a list. */
export const FIXTURE_REQUIRED_REVIEWERS_TYPE = "number";
