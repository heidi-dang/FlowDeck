/** M3 migration: durable execution plans, workstreams, ownership, leases and integration attempts. */
export const MIGRATION_V3_EXECUTION_SQL = `
CREATE TABLE IF NOT EXISTS execution_plans (
  plan_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  routing_decision_id TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','running','succeeded','failed','cancelled','superseded')),
  UNIQUE(run_id, plan_id),
  FOREIGN KEY(run_id) REFERENCES task_runs(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_execution_plans_run ON execution_plans(run_id, created_at);

CREATE TABLE IF NOT EXISTS execution_workstreams (
  workstream_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  resolved_agent TEXT NOT NULL,
  required_capability TEXT NOT NULL,
  objective TEXT NOT NULL,
  requirements_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  owned_paths_json TEXT NOT NULL DEFAULT '[]',
  owned_symbols_json TEXT NOT NULL DEFAULT '[]',
  strategy TEXT NOT NULL,
  budget_profile TEXT NOT NULL CHECK(budget_profile IN ('small','normal','audit','deep-audit')),
  context_scope TEXT NOT NULL CHECK(context_scope IN ('owned','related','audit')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','blocked','ready','running','succeeded','failed','cancelled','integration_pending','integrated','superseded')),
  worktree_ref TEXT,
  branch_ref TEXT,
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plan_id, workstream_id),
  FOREIGN KEY(plan_id) REFERENCES execution_plans(plan_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(run_id) REFERENCES task_runs(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_execution_workstreams_plan ON execution_workstreams(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_execution_workstreams_run ON execution_workstreams(run_id, status);

CREATE TABLE IF NOT EXISTS execution_dependencies (
  plan_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY(plan_id, workstream_id, depends_on),
  CHECK(workstream_id <> depends_on),
  FOREIGN KEY(plan_id, workstream_id) REFERENCES execution_workstreams(plan_id, workstream_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(plan_id, depends_on) REFERENCES execution_workstreams(plan_id, workstream_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_execution_dependencies_dep ON execution_dependencies(plan_id, depends_on);

CREATE TABLE IF NOT EXISTS execution_ownership_claims (
  claim_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  ownership_type TEXT NOT NULL CHECK(ownership_type IN ('file','directory','pattern','symbol')),
  ownership_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','released','conflicted')),
  created_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE(plan_id, normalized_value, status),
  FOREIGN KEY(plan_id, workstream_id) REFERENCES execution_workstreams(plan_id, workstream_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_execution_ownership_plan ON execution_ownership_claims(plan_id, status);

CREATE TABLE IF NOT EXISTS execution_worktree_leases (
  lease_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  branch TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'allocated' CHECK(state IN ('requested','allocated','active','renewing','completed','reclaimable','released','failed')),
  UNIQUE(worktree_id, state),
  UNIQUE(workstream_id, state),
  FOREIGN KEY(plan_id, workstream_id) REFERENCES execution_workstreams(plan_id, workstream_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_execution_leases_expiry ON execution_worktree_leases(expires_at, state);
CREATE INDEX IF NOT EXISTS idx_execution_leases_run ON execution_worktree_leases(run_id, state);

CREATE TABLE IF NOT EXISTS execution_integration_attempts (
  attempt_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started','verified','conflict','integrated','failed','cancelled')),
  verification_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(workstream_id, attempt_id),
  FOREIGN KEY(plan_id, workstream_id) REFERENCES execution_workstreams(plan_id, workstream_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_execution_integrations_plan ON execution_integration_attempts(plan_id, status);
`;
