/**
 * Operation Lifecycle — one stable identity across operation.started →
 * operation.completed / operation.failed / operation.cancelled.
 *
 * Authority order for the stable operation ID:
 *   existing tool call ID (preferred)
 *   → a deterministic FlowDeck operation ID derived once
 *   → reused by started / terminal events
 *
 * The same ID is reused by Runtime Self-Audit, the score stream, the persisted
 * scoreboard, and the WebUI action row, so one logical action stays one row that
 * updates in place. Exactly one terminal state per operation. This module is
 * framework-agnostic and deterministic.
 */

export type OperationStatus = "started" | "completed" | "failed" | "cancelled"

export interface OperationSpec {
  sessionId: string
  /** The existing tool call ID when available — the preferred identity authority. */
  toolCallId?: string
  actionClass: string
  label: string
  /** Optional explicit opId; otherwise derived deterministically. */
  opId?: string
}

export interface OperationState {
  opId: string
  sessionId: string
  toolCallId?: string
  actionClass: string
  label: string
  status: OperationStatus
  exitCode?: number
  stderrSummary?: string
  score?: number
  startedAt: number
  terminalAt?: number
}

/** Terminals. Exactly one of these may ever be active per operation. */
const TERMINALS: ReadonlySet<OperationStatus> = new Set(["completed", "failed", "cancelled"])

/**
 * Derive a stable operation ID. Prefers the existing tool call ID; otherwise a
 * deterministic hash of (sessionId + label) so a different command/action gets a
 * different ID without needing a random source at terminal time.
 */
export function deriveOperationId(sessionId: string, toolCallId?: string, label?: string): string {
  // Stable hash of (session, preferred tool-call id, effective action label) so
  // the identity is reused across started→terminal and a genuinely different
  // command/strategy gets a different lifecycle. The label is normalized so
  // trivial whitespace/quote differences do not churn the identity.
  const normLabel = (label ?? "").replace(/\s+/g, " ").trim()
  const base = (sessionId || "no-session") + "|" + (toolCallId ?? "")
  const seed = base + "|" + normLabel
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return "op_" + h.toString(16)
}

/** Bound stderr into a short, safe summary (redacted upstream). */
export function summarizeStderr(stderr: string, max = 300): string | undefined {
  const s = (stderr ?? "").trim()
  if (!s) return undefined
  return s.length > max ? s.slice(0, max) + "…" : s
}

export class OperationLifecycle {
  private ops = new Map<string, OperationState>()

  begin(spec: OperationSpec): OperationState {
    const opId = spec.opId ?? deriveOperationId(spec.sessionId, spec.toolCallId, spec.label)
    const existing = this.ops.get(opId)
    if (existing) return existing // idempotent begin
    const state: OperationState = {
      opId,
      sessionId: spec.sessionId,
      toolCallId: spec.toolCallId,
      actionClass: spec.actionClass,
      label: spec.label,
      status: "started",
      startedAt: Date.now(),
    }
    this.ops.set(opId, state)
    return state
  }

  /** Transition started → completed. Returns the new terminal state or null if not allowed. */
  complete(opId: string, patch: { exitCode?: number; score?: number; stderrSummary?: string } = {}): OperationState | null {
    return this.terminal(opId, "completed", patch)
  }

  /** Transition started → failed (the authoritative terminal for a non-zero tool execution). */
  fail(opId: string, patch: { exitCode?: number; score?: number; stderrSummary?: string } = {}): OperationState | null {
    return this.terminal(opId, "failed", patch)
  }

  /** Transition started → cancelled (e.g. pre-execution block). */
  cancel(opId: string): OperationState | null {
    return this.terminal(opId, "cancelled", {})
  }

  private terminal(opId: string, status: OperationStatus, patch: { exitCode?: number; score?: number; stderrSummary?: string }): OperationState | null {
    const state = this.ops.get(opId)
    if (!state) return null
    if (TERMINALS.has(state.status)) return null // exactly one terminal state
    if (!TERMINALS.has(status)) return null
    state.status = status
    state.terminalAt = Date.now()
    if (typeof patch.exitCode === "number") state.exitCode = patch.exitCode
    if (typeof patch.score === "number") state.score = patch.score
    if (typeof patch.stderrSummary === "string") state.stderrSummary = patch.stderrSummary
    return state
  }

  get(opId: string): OperationState | undefined {
    return this.ops.get(opId)
  }

  /** Exactly one tracked row for a given opId (regardless of how many events touched it). */
  rowCount(opId: string): number {
    return this.ops.has(opId) ? 1 : 0
  }

  terminalOf(opId: string): OperationStatus | undefined {
    return this.ops.get(opId)?.status
  }

  clearSession(sessionId: string): void {
    for (const [opId, st] of this.ops.entries()) {
      if (st.sessionId === sessionId) this.ops.delete(opId)
    }
  }

  clearAll(): void {
    this.ops.clear()
  }
}
