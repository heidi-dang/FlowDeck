# v2 security boundaries

Worktree paths are resolved beneath the configured worktree root. Branch components are sanitized before Git invocation, Git commands use argument arrays, and symlink targets outside the worktree are rejected. Ownership is normalized before comparison and checked again against the final diff.

SQLite writes use parameterized queries and the existing transaction manager. Finalized routing decisions, execution plans, integration attempts, usage records, and performance observations are append-only. A reassessment creates a new version rather than updating history.

Metrics have bounded dimensions only. Run IDs, session IDs, workstream IDs, SHAs, paths, prompts, and workspace paths are forbidden labels. FDX IPC validates the method, workspace containment, key size, request size, value size, and timeout/fallback behavior.

Shadow failures are diagnostic. They do not fail an ordinary OpenCode run, change the selected provider, consume an unrelated budget, or mark completion.
