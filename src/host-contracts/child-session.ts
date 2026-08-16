/**
 * ChildSessionRef — a minimal reference to a host-managed child session.
 *
 * FlowDeck tracks which host sessions correspond to its workstreams for:
 *   - cancellation,
 *   - follow-up delegation,
 *   - lifecycle observation (started / completed / failed),
 *   - budget reconciliation using session-level token usage.
 *
 * FlowDeck does NOT own or store conversation content.
 * The host (OpenCode, DSH) is the canonical store for model-visible history.
 */

/**
 * Reference to a child session managed by the execution host.
 * Contains only the identity and lifecycle metadata FlowDeck needs.
 * Never contains conversation messages or model outputs.
 */
export interface ChildSessionRef {
  /**
   * Host-assigned session identifier.
   * Opaque to FlowDeck; passed back to the host for cancellation/follow-up.
   */
  readonly sessionId: string

  /**
   * FlowDeck workstream identifier this session is executing.
   * Used to correlate host events back to FlowDeck's orchestration DAG.
   */
  readonly workstreamId: string

  /**
   * The agent/specialist role assigned to this child session.
   * Set at creation; used for delegation validation and audit.
   */
  readonly resolvedAgent: string

  /**
   * ISO timestamp when the child session was created by the host.
   */
  readonly createdAt: string
}

/**
 * Minimal host-side child execution operations FlowDeck needs.
 * Implemented by the host adapter (OpenCode or DSH).
 *
 * Note: IsolatedWorkstreamExecutor (in orchestration/execution/worktree-executor.ts)
 * is the primary contract for worktree-based isolated execution. ChildSessionHost
 * covers the session-tracking concerns that sit beside it.
 */
export interface ChildSessionHost {
  /**
   * Cancel the child session identified by sessionId.
   * Must be idempotent — cancelling a completed session is a no-op.
   */
  cancel(sessionId: string): Promise<void>

  /**
   * Send a follow-up prompt to a running or paused child session.
   * Only called when the host supports continuable delegation.
   */
  followup?(sessionId: string, prompt: string): Promise<void>
}
