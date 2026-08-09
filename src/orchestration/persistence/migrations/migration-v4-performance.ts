export const MIGRATION_V4_PERFORMANCE_SQL = `
CREATE TABLE IF NOT EXISTS agent_performance_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  task_class TEXT NOT NULL,
  strategy TEXT NOT NULL,
  complexity_band TEXT NOT NULL CHECK(complexity_band IN ('low','medium','high')),
  risk_band TEXT NOT NULL CHECK(risk_band IN ('low','medium','high')),
  success INTEGER NOT NULL CHECK(success IN (0,1)),
  verification_passed INTEGER NOT NULL CHECK(verification_passed IN (0,1)),
  integration_passed INTEGER NOT NULL CHECK(integration_passed IN (0,1)),
  token_reserved INTEGER NOT NULL CHECK(token_reserved >= 0),
  token_used INTEGER NOT NULL CHECK(token_used >= 0),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  retry_count INTEGER NOT NULL CHECK(retry_count >= 0),
  review_findings INTEGER NOT NULL CHECK(review_findings >= 0),
  regression_count INTEGER NOT NULL CHECK(regression_count >= 0),
  termination_reason TEXT NOT NULL,
  usefulness_signals_json TEXT NOT NULL DEFAULT '[]',
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, workstream_id)
);
CREATE INDEX IF NOT EXISTS idx_performance_agent_capability ON agent_performance_observations(agent_id, capability, created_at);
CREATE INDEX IF NOT EXISTS idx_performance_run ON agent_performance_observations(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_performance_task_context ON agent_performance_observations(capability, task_class, strategy);
`;
