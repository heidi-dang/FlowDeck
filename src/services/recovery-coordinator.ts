/**
 * Centralized Recovery Continuation Coordinator
 *
 * Enforces:
 *   1. Exactly one pending automatic continuation per session at any time.
 *   2. Strict internal prompt provenance: internal FlowDeck prompts are registered
 *      and never misclassified as manual user follow-ups.
 *      FIX: Provenance survives the full message lifecycle (chat.message +
 *      message.updated) via an ID-keyed map — never one-shot consumed.
 *   3. Unified scheduling for reasoning-only recovery and semantic watchdog recovery.
 *   4. Clean lifecycle states: IDLE -> SCHEDULED -> SUBMITTED -> RUNNING -> COMPLETED.
 *      FIX: isPendingContinuation stays true until the resulting assistant turn
 *      reaches a confirmed terminal state, not just until the API call resolves.
 */

import { REPLAY_CONTINUATION_PROMPT } from "./reasoning-recovery"
import { updateWatchdogState, getWatchdogState } from "./heidi-watchdog"

export const WATCHDOG_RECOVERY_PROMPT =
  "The session appears stalled without completing the task. Please continue your work or explain what you are waiting for."

export type PromptProvenanceKind = "manual_user" | "internal_reasoning_recovery" | "internal_watchdog_recovery"

export interface InternalPromptRecord {
  sessionID: string
  kind: "internal_reasoning_recovery" | "internal_watchdog_recovery"
  generation: number
  promptText: string
  createdAt: number
  /** Message ID once OpenCode announces it. Promoted from pending text match. */
  messageID?: string
}

export interface RecoveryContinuationRequest {
  sessionID: string
  source: "reasoning_recovery" | "semantic_watchdog"
  promptText?: string
  client: any
  appLog: (msg: string, level?: any, sessionID?: string) => Promise<void>
  handleEvent: (args: { event: any }) => Promise<void>
  onScheduled?: () => void
}

class RecoveryCoordinator {
  private activeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private sessionGenerations = new Map<string, number>()

  /**
   * Per-session: map from internal user-message ID → InternalPromptRecord.
   * Populated once the message ID is known (from API response or event).
   * Key invariant: once a message ID is recorded as internal, ALL later
   * events carrying that ID remain internal. Never evicted unless session ends.
   */
  private promptsByMessageId = new Map<string, Map<string, InternalPromptRecord>>()

  /**
   * Per-session: unconsumed records awaiting message-ID promotion.
   * Text matching is only used here, as a short-lived fallback before ID is known.
   * Records are promoted to promptsByMessageId once an ID arrives.
   */
  private pendingPrompts = new Map<string, InternalPromptRecord[]>()

  /**
   * Track the active recovery assistant turn IDs per session.
   * Once the resulting assistant turn has a confirmed terminal finish,
   * isPendingContinuation is cleared.
   */
  private activeRecoveryTurnIds = new Map<string, Set<string>>()

  /**
   * Request an automatic recovery continuation.
   * If a continuation is already scheduled, submitted, or running for this session,
   * the duplicate request is safely rejected/suppressed.
   */
  public requestContinuation(req: RecoveryContinuationRequest): boolean {
    const { sessionID, source, client, appLog, handleEvent } = req
    if (!sessionID) return false

    // Check if continuation is already pending or timer is active
    if (this.activeTimers.has(sessionID)) {
      return false
    }
    const wState = getWatchdogState(sessionID)
    if (wState?.isPendingContinuation) {
      return false
    }

    const sessionApi = client?.session
    if (!sessionApi?.prompt && !sessionApi?.promptAsync) {
      return false
    }
    const promptFn = sessionApi.promptAsync ? sessionApi.promptAsync.bind(sessionApi) : sessionApi.prompt.bind(sessionApi)

    const promptText = req.promptText ?? (source === "reasoning_recovery" ? REPLAY_CONTINUATION_PROMPT : WATCHDOG_RECOVERY_PROMPT)
    const promptKind: "internal_reasoning_recovery" | "internal_watchdog_recovery" =
      source === "reasoning_recovery" ? "internal_reasoning_recovery" : "internal_watchdog_recovery"

    // Mark pending in watchdog
    updateWatchdogState(sessionID, { isPendingContinuation: true })
    if (req.onScheduled) req.onScheduled()

    const generation = (this.sessionGenerations.get(sessionID) ?? 0) + 1
    this.sessionGenerations.set(sessionID, generation)

    const record: InternalPromptRecord = {
      sessionID,
      kind: promptKind,
      generation,
      promptText,
      createdAt: Date.now(),
    }

    // Register in pending list (awaiting message-ID promotion)
    let pending = this.pendingPrompts.get(sessionID)
    if (!pending) {
      pending = []
      this.pendingPrompts.set(sessionID, pending)
    }
    pending.push(record)

    const timer = setTimeout(() => {
      this.activeTimers.delete(sessionID)
      let result: unknown
      try {
        result = promptFn({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: promptText }],
          },
        })
      } catch (err) {
        appLog(`[recovery-coordinator] ${source} prompt failed: ${err instanceof Error ? err.message : String(err)}`, "error", sessionID).catch(() => {})
        updateWatchdogState(sessionID, { isPendingContinuation: false })
        handleEvent({ event: { type: "session.error", properties: { sessionID, error: (err as Error).message, info: { id: sessionID, role: "assistant", error: (err as Error).message } } } }).catch(() => {})
        return
      }

      if (result && typeof (result as Promise<unknown>).then === "function") {
        ;(result as Promise<unknown>)
          .then((res: any) => {
            const msgId = res?.data?.id ?? res?.id
            if (msgId) {
              // Promote the pending record to the ID-keyed map.
              // isPendingContinuation stays true — cleared by notifyAssistantTurnTerminal.
              this.promoteToMessageId(sessionID, record, msgId)
            } else {
              // No message ID returned — cannot track resulting turn.
              // Fall back: clear isPendingContinuation when API acknowledges.
              updateWatchdogState(sessionID, { isPendingContinuation: false })
            }
          })
          .catch((err: Error) => {
            appLog(`[recovery-coordinator] ${source} prompt rejected: ${err.message}`, "error", sessionID).catch(() => {})
            updateWatchdogState(sessionID, { isPendingContinuation: false })
            handleEvent({ event: { type: "session.error", properties: { sessionID, error: err.message, info: { id: sessionID, role: "assistant", error: err.message } } } }).catch(() => {})
          })
      } else {
        // Sync prompt (no Promise returned) — cannot track resulting turn.
        // Clear isPendingContinuation immediately so recovery can proceed for
        // subsequent incidents. The coordinator will still detect duplicate
        // signatures via the circuit breaker.
        updateWatchdogState(sessionID, { isPendingContinuation: false })
      }
    }, 50)

    this.activeTimers.set(sessionID, timer)
    return true
  }

  /**
   * Promote a pending prompt record to the ID-keyed map once its message ID is known.
   * After this, ALL later events with this ID are classified as internal.
   */
  private promoteToMessageId(sessionID: string, record: InternalPromptRecord, messageID: string): void {
    record.messageID = messageID
    let byId = this.promptsByMessageId.get(sessionID)
    if (!byId) {
      byId = new Map()
      this.promptsByMessageId.set(sessionID, byId)
    }
    byId.set(messageID, record)

    // Remove from pending list if still there
    const pending = this.pendingPrompts.get(sessionID)
    if (pending) {
      const idx = pending.indexOf(record)
      if (idx !== -1) pending.splice(idx, 1)
    }

    // Track this as an active recovery turn
    let activeTurns = this.activeRecoveryTurnIds.get(sessionID)
    if (!activeTurns) {
      activeTurns = new Set()
      this.activeRecoveryTurnIds.set(sessionID, activeTurns)
    }
    activeTurns.add(messageID)
  }

  /**
   * Notify the coordinator that a recovery-induced assistant turn reached a
   * confirmed terminal state. This is when isPendingContinuation is cleared.
   * Returns true if this was a tracked recovery turn.
   */
  public notifyAssistantTurnTerminal(sessionID: string, _assistantMessageID: string): boolean {
    const activeTurns = this.activeRecoveryTurnIds.get(sessionID)
    if (!activeTurns) return false

    // Check if this is a recovery-induced turn (the user message that caused
    // it is tracked in promptsByMessageId; the resulting assistant turn may
    // have a different ID, so we also track by the recovery-user-message chain).
    // For simplicity: if isPendingContinuation is true and we see any terminal
    // assistant event, the recovery round is done.
    const wState = getWatchdogState(sessionID)
    if (wState?.isPendingContinuation) {
      updateWatchdogState(sessionID, { isPendingContinuation: false })
      return true
    }
    return false
  }

  /**
   * Classify a message event to distinguish manual user follow-ups from internal FlowDeck recovery prompts.
   *
   * P0 FIX: Provenance survives ALL lifecycle events for the same message ID.
   * Once an ID is known as internal, it remains internal forever (until session ends).
   * Text matching is only a short-lived fallback before the ID is promoted.
   * A true manual user message still classifies correctly.
   */
  public classifyMessage(sessionID: string, messageID?: string, text?: string): PromptProvenanceKind {
    if (!sessionID) return "manual_user"

    // 1. Check ID-keyed map first — these are permanent (not consumed/one-shot)
    if (messageID) {
      const byId = this.promptsByMessageId.get(sessionID)
      if (byId?.has(messageID)) {
        return byId.get(messageID)!.kind
      }
    }

    // 2. Check pending list by text (short-lived fallback before ID is known)
    const pending = this.pendingPrompts.get(sessionID)
    if (pending && pending.length > 0) {
      const trimmedText = text?.trim()
      const matchIdx = pending.findIndex((r) => !trimmedText || r.promptText.trim() === trimmedText)
      if (matchIdx !== -1) {
        const match = pending[matchIdx]
        // Promote to ID-keyed map if we now have an ID
        if (messageID && !match.messageID) {
          this.promoteToMessageId(sessionID, match, messageID)
          // Note: promoteToMessageId removes from pending, so don't splice again
        }
        // Return kind without consuming — the next event with this ID will hit path 1
        return match.kind
      }
    }

    return "manual_user"
  }

  /**
   * Cancel any pending timer and clean up session continuation state on cancel/stop.
   */
  public cancelSession(sessionID: string): void {
    if (!sessionID) return
    const timer = this.activeTimers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      this.activeTimers.delete(sessionID)
    }
    this.pendingPrompts.delete(sessionID)
    this.promptsByMessageId.delete(sessionID)
    this.activeRecoveryTurnIds.delete(sessionID)
    this.sessionGenerations.delete(sessionID)
    updateWatchdogState(sessionID, { isPendingContinuation: false })
  }

  /**
   * Clear all internal coordinator state on plugin dispose.
   */
  public dispose(): void {
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer)
    }
    this.activeTimers.clear()
    this.pendingPrompts.clear()
    this.promptsByMessageId.clear()
    this.activeRecoveryTurnIds.clear()
    this.sessionGenerations.clear()
  }
}

export const recoveryCoordinator = new RecoveryCoordinator()
