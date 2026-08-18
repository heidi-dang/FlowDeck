/**
 * Centralized Recovery Continuation Coordinator
 *
 * Enforces:
 *   1. Exactly one pending automatic continuation per session at any time.
 *   2. Strict internal prompt provenance: internal FlowDeck prompts are registered
 *      and never misclassified as manual user follow-ups.
 *   3. Unified scheduling for reasoning-only recovery and semantic watchdog recovery.
 *   4. Clean lifecycle states: IDLE -> SCHEDULED -> SUBMITTED -> RUNNING -> COMPLETED.
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
  messageID?: string
  consumed: boolean
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
  private internalPrompts = new Map<string, InternalPromptRecord[]>()

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
      consumed: false,
    }

    let records = this.internalPrompts.get(sessionID)
    if (!records) {
      records = []
      this.internalPrompts.set(sessionID, records)
    }
    records.push(record)

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
              record.messageID = msgId
            }
            updateWatchdogState(sessionID, { isPendingContinuation: false })
          })
          .catch((err: Error) => {
            appLog(`[recovery-coordinator] ${source} prompt rejected: ${err.message}`, "error", sessionID).catch(() => {})
            updateWatchdogState(sessionID, { isPendingContinuation: false })
            handleEvent({ event: { type: "session.error", properties: { sessionID, error: err.message, info: { id: sessionID, role: "assistant", error: err.message } } } }).catch(() => {})
          })
      } else {
        updateWatchdogState(sessionID, { isPendingContinuation: false })
      }
    }, 50)

    this.activeTimers.set(sessionID, timer)
    return true
  }

  /**
   * Classify a message event to distinguish manual user follow-ups from internal FlowDeck recovery prompts.
   */
  public classifyMessage(sessionID: string, messageID?: string, text?: string): PromptProvenanceKind {
    if (!sessionID) return "manual_user"
    const records = this.internalPrompts.get(sessionID)
    if (!records || records.length === 0) return "manual_user"

    // Match by messageID if available
    if (messageID) {
      const matchById = records.find((r) => !r.consumed && r.messageID === messageID)
      if (matchById) {
        matchById.consumed = true
        return matchById.kind
      }
    }

    // Match unconsumed internal record by prompt content or pending queue
    const trimmedText = text?.trim()
    const matchByText = records.find((r) => !r.consumed && (!trimmedText || r.promptText.trim() === trimmedText))
    if (matchByText) {
      matchByText.consumed = true
      if (messageID && !matchByText.messageID) {
        matchByText.messageID = messageID
      }
      return matchByText.kind
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
    this.internalPrompts.delete(sessionID)
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
    this.internalPrompts.clear()
    this.sessionGenerations.clear()
  }
}

export const recoveryCoordinator = new RecoveryCoordinator()
