/** v0.2.12 canonical assignment ↔ execution-workstream binding + dispatch attempt state.
 *
 * This is general runtime infrastructure, not command-specific bookkeeping.
 * It gives the canonical assignment-dispatch layer a durable, idempotent
 * link between a logical Assignment and the ExecutionPlan Workstream it serves,
 * plus bounded dispatch-attempt identity required to reconcile a crash that
 * occurs after the dispatch boundary (R9).
 */
export const MIGRATION_V7_ASSIGNMENT_BINDING_SQL = `
CREATE TABLE IF NOT EXISTS assignment_execution_bindings (
  assignment_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  dispatch_state TEXT NOT NULL DEFAULT 'pending'
      CHECK(dispatch_state IN ('pending','dispatched','succeeded','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_attempt_id TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plan_id, workstream_id)
);
CREATE INDEX IF NOT EXISTS idx_aeb_run ON assignment_execution_bindings(run_id);
CREATE INDEX IF NOT EXISTS idx_aeb_plan ON assignment_execution_bindings(plan_id);
CREATE INDEX IF NOT EXISTS idx_aeb_correlation ON assignment_execution_bindings(correlation_id);
`;
