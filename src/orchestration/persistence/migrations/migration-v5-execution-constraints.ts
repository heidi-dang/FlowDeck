/** v0.2.10 execution integrity constraints for databases already on v3/v4. */
export const MIGRATION_V5_EXECUTION_CONSTRAINTS_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_live_worktree_unique
  ON execution_worktree_leases(worktree_id)
  WHERE state IN ('requested','allocated','active','renewing');
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_live_workstream_unique
  ON execution_worktree_leases(workstream_id)
  WHERE state IN ('requested','allocated','active','renewing');
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_integrated_workstream_unique
  ON execution_integration_attempts(workstream_id)
  WHERE status = 'integrated';
`;
