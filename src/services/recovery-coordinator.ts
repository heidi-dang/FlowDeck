/**
 * Centralized Recovery Continuation Coordinator
 *
 * Enforces:
 *   1. Exactly one pending automatic continuation per session at any time.
 *   2. Strict internal prompt provenance: internal FlowDeck prompts are registered
 *      and never misclassified as manual user follow-ups.
 *      Provenance survives the full message lifecycle (chat.message + message.updated)
 *      via an ID-keyed map — never one-shot consumed.
 *      Empty/missing text does NOT match an internal prompt.
 *   3. Unified scheduling for reasoning-only recovery and semantic watchdog recovery.
 *   4. Full recovery generation lifecycle with preflight revalidation at submission time.
 *      The 50ms timer MUST revalidate live session state before sending the prompt.
 *      Every pre-submit cancellation or suppression releases isPendingContinuation.
 *   5. Recovery completion is correlated to the specific assistant response created
 *      by the recovery generation via the internal user-prompt message ID.
 *      Telemetry is emitted for exact match, ordered fallback, and rejection.
 */

import { REPLAY_CONTINUATION_PROMPT } from "./reasoning-recovery"
import { updateWatchdogState, getWatchdogState } from "./heidi-watchdog"

export const WATCHDOG_RECOVERY_PROMPT =
  "The session appears stalled without completing the task. Please continue your work or explain what you are waiting for."

export type PromptProvenanceKind =
  | "manual_user"
  | "internal_reasoning_recovery"
  | "internal_watchdog_recovery"
  | "internal_parallel_child_ready"
  | "unknown_user_event"

export interface InternalPromptRecord {
  sessionID: string
  kind: "internal_reasoning_recovery" | "internal_watchdog_recovery" | "internal_parallel_child_ready"
  generation: number
  promptText: string
  createdAt: number
  /** Message ID once OpenCode announces it. Promoted from pending text match. */
  messageID?: string
}

export type RecoveryGenerationState =
  | "SCHEDULED"
  | "SUBMITTED"
  | "SUBMITTED_UNCORRELATED"
  | "RUNNING"
  | "TERMINAL"
  | "CANCELLED"
  | "FAILED"
  | "EXHAUSTED"

export interface RecoveryGeneration {
  sessionID: string
  incidentID?: string
  generation: number
  directiveOrdinal?: number
  source: "reasoning_recovery" | "semantic_watchdog" | "orchestrator_guard" | string
  state: RecoveryGenerationState
  /** The internal user-prompt message ID returned by the prompt API. */
  internalPromptMessageId?: string
  /** The assistant message ID that is the direct response to the recovery prompt. */
  assistantResponseMessageId?: string
  createdAt: number
  submittedAt?: number
  cancelledAt?: number
  completedAt?: number
  handleEvent?: (args: { event: any }) => Promise<void>
}

export type RecoverySuppressionReason =
  | "ALREADY_IN_FLIGHT"
  | "DUPLICATE_GENERATION"
  | "SUPERSEDED"
  | "TERMINAL_SESSION"
  | "PROGRESS_ALREADY_OBSERVED"
  | "RECOVERY_OWNER_CONFLICT"
  | "EXHAUSTED"
  | "NO_SESSION"
  | "NO_API"

export interface CanInjectRecoveryContinuationOptions {
  sessionID: string
  incidentID?: string
  generation?: number
  source: string
  client?: any
}

export interface AdmissionDecision {
  allowed: boolean
  suppressionReason?: RecoverySuppressionReason
}

export interface RecoveryContinuationRequest {
  sessionID: string
  source: "reasoning_recovery" | "semantic_watchdog"
  promptText?: string
  client: any
  appLog: (msg: string, level?: any, sessionID?: string) => Promise<void>
  handleEvent: (args: { event: any }) => Promise<void>
  onScheduled?: () => void
  /** Live session-state check injected by caller for preflight revalidation. */
  getSessionState?: () => {
    isPendingProvider: boolean
    isPendingTool: boolean
    isPendingChild: boolean
    isCancelled: boolean
    hasNewerUserMessage: boolean
  } | null
}

/** Bounded orphan-generation timeout (ms). */
const ORPHAN_GENERATION_TIMEOUT_MS = 120_000 // 2 minutes

export type RecoveryTelemetryEvent = {
  sessionID: string
  eventName: string
  details: Record<string, unknown>
}

class RecoveryCoordinator {
  private activeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private orphanTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private sessionGenerations = new Map<string, number>()
  /** Per-session: current recovery generation record. */
  private activeGenerations = new Map<string, RecoveryGeneration>()
  private telemetryListeners = new Set<(event: RecoveryTelemetryEvent) => void>()

  /**
   * Register a listener for recovery telemetry events.
   * Returns an unsubscribe callback.
   */
  public onTelemetry(listener: (event: RecoveryTelemetryEvent) => void): () => void {
    this.telemetryListeners.add(listener)
    return () => this.telemetryListeners.delete(listener)
  }

  /**
   * Per-session: map from internal user-message ID → InternalPromptRecord.
   * Populated once the message ID is known (from API response or event).
   * Key invariant: once a message ID is recorded as internal, ALL later
   * events carrying that ID remain internal. Never evicted unless session ends.
   */
  private promptsByMessageId = new Map<string, Map<string, InternalPromptRecord>>()

  /**
   * Per-session: prompt records awaiting message-ID promotion.
   * Text matching is only used here, as a short-lived fallback before ID is known.
   * Records are promoted to promptsByMessageId once an ID arrives.
   * INVARIANT: empty/missing text NEVER matches — only exact non-empty prompt text.
   */
  private pendingPrompts = new Map<string, InternalPromptRecord[]>()

  /**
   * Request an automatic recovery continuation.
   * If a continuation is already scheduled, submitted, or running for this session,
   * the duplicate request is safely rejected/suppressed.
   */
  /**
   * Authoritative recovery admission gate.
   */
  public canInjectRecoveryContinuation(opts: CanInjectRecoveryContinuationOptions): AdmissionDecision {
    const { sessionID, generation, client } = opts
    if (!sessionID) {
      return { allowed: false, suppressionReason: "NO_SESSION" }
    }

    if (this.activeTimers.has(sessionID)) {
      return { allowed: false, suppressionReason: "ALREADY_IN_FLIGHT" }
    }

    const wState = getWatchdogState(sessionID)
    if (wState?.isPendingContinuation) {
      return { allowed: false, suppressionReason: "ALREADY_IN_FLIGHT" }
    }

    if (wState?.recoveryExhausted) {
      return { allowed: false, suppressionReason: "EXHAUSTED" }
    }

    if (wState?.isTerminalTask) {
      return { allowed: false, suppressionReason: "TERMINAL_SESSION" }
    }

    const activeGen = this.activeGenerations.get(sessionID)
    if (activeGen && (activeGen.state === "SCHEDULED" || activeGen.state === "SUBMITTED" || activeGen.state === "SUBMITTED_UNCORRELATED" || activeGen.state === "RUNNING")) {
      return { allowed: false, suppressionReason: "ALREADY_IN_FLIGHT" }
    }

    if (generation !== undefined && activeGen && activeGen.generation === generation && activeGen.state !== "CANCELLED" && activeGen.state !== "FAILED") {
      return { allowed: false, suppressionReason: "DUPLICATE_GENERATION" }
    }

    if (client) {
      const sessionApi = client?.session
      if (!sessionApi?.prompt && !sessionApi?.promptAsync) {
        return { allowed: false, suppressionReason: "NO_API" }
      }
    }

    return { allowed: true }
  }

  /**
   * Request an automatic recovery continuation.
   * If a continuation is already scheduled, submitted, or running for this session,
   * the duplicate request is safely rejected/suppressed.
   */
  public requestContinuation(req: RecoveryContinuationRequest): boolean {
    const { sessionID, source, client, appLog, handleEvent } = req
    const admission = this.canInjectRecoveryContinuation({
      sessionID,
      source,
      client,
    })
    if (!admission.allowed) {
      this._emitTelemetry(handleEvent, sessionID, "recovery_continuation_suppressed", {
        reason: admission.suppressionReason,
        source,
      })
      return false
    }

    const sessionApi = client?.session
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

    const genRecord: RecoveryGeneration = {
      sessionID,
      generation,
      source,
      state: "SCHEDULED",
      createdAt: Date.now(),
      handleEvent,
    }
    this.activeGenerations.set(sessionID, genRecord)

    // Register in pending list (awaiting message-ID promotion)
    let pending = this.pendingPrompts.get(sessionID)
    if (!pending) {
      pending = []
      this.pendingPrompts.set(sessionID, pending)
    }
    pending.push(record)

    const timer = setTimeout(() => {
      this.activeTimers.delete(sessionID)

      // ── PREFLIGHT REVALIDATION ──────────────────────────────────────────────
      // The 50ms debounce does NOT guarantee stable state. Re-read live state
      // immediately before sending the prompt. If anything changed, suppress and
      // completely release pending continuation state.
      const currentGen = this.activeGenerations.get(sessionID)
      if (!currentGen || currentGen.generation !== generation || currentGen.state === "CANCELLED") {
        // Generation was superseded or cancelled while timer was pending
        appLog(`[recovery-coordinator] preflight: generation ${generation} superseded/cancelled for ${sessionID}`, "debug", sessionID).catch(() => {})
        this._emitTelemetry(handleEvent, sessionID, "recovery_preflight_suppressed", { reason: "generation_superseded", generation })
        this._abortGeneration(sessionID, generation, record, currentGen)
        return
      }

      const liveState = getWatchdogState(sessionID)
      if (!liveState) {
        // Session was cleaned up while timer was pending
        appLog(`[recovery-coordinator] preflight: session ${sessionID} no longer exists`, "debug", sessionID).catch(() => {})
        this._emitTelemetry(handleEvent, sessionID, "recovery_preflight_suppressed", { reason: "session_gone", generation })
        this._abortGeneration(sessionID, generation, record, genRecord)
        return
      }
      if (liveState.isPendingProvider) {
        appLog(`[recovery-coordinator] preflight: provider now pending for ${sessionID}; suppressing recovery`, "debug", sessionID).catch(() => {})
        this._emitTelemetry(handleEvent, sessionID, "recovery_preflight_suppressed", { reason: "provider_pending", generation })
        this._abortGeneration(sessionID, generation, record, genRecord)
        return
      }
      if (liveState.isPendingTool) {
        appLog(`[recovery-coordinator] preflight: tool now pending for ${sessionID}; suppressing recovery`, "debug", sessionID).catch(() => {})
        this._emitTelemetry(handleEvent, sessionID, "recovery_preflight_suppressed", { reason: "tool_pending", generation })
        this._abortGeneration(sessionID, generation, record, genRecord)
        return
      }
      if (liveState.isPendingChild) {
        appLog(`[recovery-coordinator] preflight: child now pending for ${sessionID}; suppressing recovery`, "debug", sessionID).catch(() => {})
        this._emitTelemetry(handleEvent, sessionID, "recovery_preflight_suppressed", { reason: "child_pending", generation })
        this._abortGeneration(sessionID, generation, record, genRecord)
        return
      }

      // Allow caller to inject additional preflight checks (e.g. newer user message)
      const callerState = req.getSessionState?.()
      if (callerState === null) {
        // Session gone from caller's perspective
        appLog(`[recovery-coordinator] preflight: session gone (caller check) for ${sessionID}`, "debug", sessionID).catch(() => {})
        this._emitTelemetry(handleEvent, sessionID, "recovery_preflight_suppressed", { reason: "session_gone_caller", generation })
        this._abortGeneration(sessionID, generation, record, genRecord)
        return
      }
      if (callerState?.isCancelled) {
        appLog(`[recovery-coordinator] preflight: session cancelled for ${sessionID}`, "debug", sessionID).catch(() => {})
        this._emitTelemetry(handleEvent, sessionID, "recovery_preflight_suppressed", { reason: "session_cancelled", generation })
        this._abortGeneration(sessionID, generation, record, genRecord)
        return
      }
      if (callerState?.hasNewerUserMessage) {
        appLog(`[recovery-coordinator] preflight: newer user message for ${sessionID}; recovery superseded`, "debug", sessionID).catch(() => {})
        this._emitTelemetry(handleEvent, sessionID, "recovery_preflight_suppressed", { reason: "newer_user_message", generation })
        this._abortGeneration(sessionID, generation, record, genRecord)
        return
      }
      if (callerState?.isPendingProvider || callerState?.isPendingTool || callerState?.isPendingChild) {
        appLog(`[recovery-coordinator] preflight: active work for ${sessionID}; suppressing recovery`, "debug", sessionID).catch(() => {})
        this._emitTelemetry(handleEvent, sessionID, "recovery_preflight_suppressed", { reason: "active_work", generation })
        this._abortGeneration(sessionID, generation, record, genRecord)
        return
      }
      // ── END PREFLIGHT ────────────────────────────────────────────────────────

      genRecord.state = "SUBMITTED"
      genRecord.submittedAt = Date.now()

      let result: unknown
      try {
        result = promptFn({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: promptText }],
          },
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        appLog(`[recovery-coordinator] ${source} prompt failed: ${errorMsg}`, "error", sessionID).catch(() => {})
        genRecord.state = "FAILED"
        genRecord.completedAt = Date.now()
        this._clearPendingIfThisGeneration(sessionID, generation, record)
        updateWatchdogState(sessionID, { isPendingContinuation: false })
        handleEvent({ event: { type: "session.error", properties: { sessionID, error: errorMsg, info: { id: sessionID, role: "assistant", error: errorMsg } } } }).catch(() => {})
        return
      }

      if (result && typeof (result as Promise<unknown>).then === "function") {
        ;(result as Promise<unknown>)
          .then((res: any) => {
            const msgId = res?.data?.id ?? res?.id
            if (msgId) {
              // Promote the pending record to the ID-keyed map.
              // Track internalPromptMessageId for correlation.
              // isPendingContinuation stays true — cleared by notifyAssistantTurnTerminal.
              genRecord.state = "RUNNING"
              genRecord.internalPromptMessageId = msgId
              this.promoteToMessageId(sessionID, record, msgId)
              // Start bounded orphan-generation timeout
              this._startOrphanTimer(sessionID, generation, genRecord, appLog, handleEvent)
            } else {
              // No message ID returned — cannot correlate resulting turn.
              // Use SUBMITTED_UNCORRELATED: keep single-flight for a bounded period.
              genRecord.state = "SUBMITTED_UNCORRELATED"
              this._startOrphanTimer(sessionID, generation, genRecord, appLog, handleEvent)
            }
          })
          .catch((err: unknown) => {
            const errorMsg = err instanceof Error ? err.message : String(err)
            appLog(`[recovery-coordinator] ${source} prompt rejected: ${errorMsg}`, "error", sessionID).catch(() => {})
            genRecord.state = "FAILED"
            genRecord.completedAt = Date.now()
            this._clearPendingIfThisGeneration(sessionID, generation, record)
            updateWatchdogState(sessionID, { isPendingContinuation: false })
            handleEvent({ event: { type: "session.error", properties: { sessionID, error: errorMsg, info: { id: sessionID, role: "assistant", error: errorMsg } } } }).catch(() => {})
          })
      } else {
        // Sync prompt (no Promise returned) — cannot correlate resulting turn.
        // Use SUBMITTED_UNCORRELATED: keep single-flight for a bounded period.
        genRecord.state = "SUBMITTED_UNCORRELATED"
        this._startOrphanTimer(sessionID, generation, genRecord, appLog, handleEvent)
      }
    }, 50)

    this.activeTimers.set(sessionID, timer)
    return true
  }

  /**
   * Centralized helper to abort a generation during preflight or cancellation.
   * Consistently suppresses submission, clears timers, removes pending records,
   * and guarantees isPendingContinuation = false.
   */
  private _abortGeneration(
    sessionID: string,
    generation: number,
    record?: InternalPromptRecord,
    genRecord?: RecoveryGeneration,
  ): void {
    const targetGen = genRecord ?? this.activeGenerations.get(sessionID)
    if (targetGen && targetGen.generation === generation) {
      if (targetGen.state !== "TERMINAL" && targetGen.state !== "FAILED") {
        targetGen.state = "CANCELLED"
        targetGen.cancelledAt = Date.now()
      }
    }
    // Clear active debounce timer if present
    const timer = this.activeTimers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      this.activeTimers.delete(sessionID)
    }
    // Clear orphan timer if present
    const orphanTimer = this.orphanTimers.get(sessionID)
    if (orphanTimer) {
      clearTimeout(orphanTimer)
      this.orphanTimers.delete(sessionID)
    }
    // Clear pending prompt records for this generation
    if (record) {
      this._clearPendingIfThisGeneration(sessionID, generation, record)
    } else {
      const pending = this.pendingPrompts.get(sessionID)
      if (pending) {
        const remaining = pending.filter((r) => r.generation !== generation)
        if (remaining.length === 0) this.pendingPrompts.delete(sessionID)
        else this.pendingPrompts.set(sessionID, remaining)
      }
    }
    updateWatchdogState(sessionID, { isPendingContinuation: false })
  }

  /** Remove a pending prompt record only if it still belongs to this generation. */
  private _clearPendingIfThisGeneration(sessionID: string, generation: number, record: InternalPromptRecord): void {
    const pending = this.pendingPrompts.get(sessionID)
    if (pending) {
      const idx = pending.indexOf(record)
      if (idx !== -1) {
        // Only remove if it hasn't been promoted and still matches this generation
        if (record.generation === generation) {
          pending.splice(idx, 1)
        }
      }
    }
  }

  /** Start a bounded orphan-generation timeout. */
  private _startOrphanTimer(
    sessionID: string,
    generation: number,
    genRecord: RecoveryGeneration,
    appLog: (msg: string, level?: any, sessionID?: string) => Promise<void>,
    handleEvent: (args: { event: any }) => Promise<void>,
  ): void {
    // Cancel any existing orphan timer for this session
    const existing = this.orphanTimers.get(sessionID)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.orphanTimers.delete(sessionID)
      const currentGen = this.activeGenerations.get(sessionID)
      if (!currentGen || currentGen.generation !== generation) return
      if (currentGen.state === "TERMINAL" || currentGen.state === "CANCELLED" || currentGen.state === "FAILED") return

      // Orphaned — no assistant response arrived within the timeout window
      currentGen.state = "FAILED"
      currentGen.completedAt = Date.now()
      appLog(`[recovery-coordinator] orphan generation ${generation} timed out for session ${sessionID}; releasing single-flight`, "warn", sessionID).catch(() => {})
      updateWatchdogState(sessionID, { isPendingContinuation: false })
      handleEvent({ event: { type: "session.error", properties: { sessionID, error: `Recovery generation ${generation} timed out without an assistant response (orphan).`, info: { id: sessionID, role: "system" } } } }).catch(() => {})
    }, ORPHAN_GENERATION_TIMEOUT_MS)

    this.orphanTimers.set(sessionID, timer)
  }

  /** Emit a diagnostic telemetry event (non-throwing). */
  private _emitTelemetry(
    handleEvent: ((args: { event: any }) => Promise<void>) | undefined,
    sessionID: string,
    eventName: string,
    details: Record<string, unknown>,
  ): void {
    const ev: RecoveryTelemetryEvent = { sessionID, eventName, details }
    for (const listener of this.telemetryListeners) {
      try {
        listener(ev)
      } catch (listenerErr) {
        console.debug?.("[recovery-coordinator] Telemetry listener error:", listenerErr)
      }
    }
    if (handleEvent) {
      handleEvent({ event: { type: "flowdeck.telemetry", properties: ev } }).catch(() => {})
    }
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
  }

  /**
   * Notify the coordinator that an assistant turn reached a confirmed terminal state.
   * Returns true if this was a tracked recovery turn that completes the active generation.
   *
   * Correlation logic:
   * - If the active generation has a known internalPromptMessageId:
   *   1. If assistantParentID matches internalPromptMessageId -> exact causal match!
   *      Emits `recovery_correlation_exact`.
   *   2. If assistantParentID is present but DOES NOT match internalPromptMessageId -> rejected!
   *      Emits `recovery_correlation_rejected`. Generation remains RUNNING.
   *   3. If assistantParentID is absent (OpenCode SDK does not populate it) and generation is RUNNING ->
   *      Ordered correlation fallback.
   *      Emits `recovery_correlation_ordered_fallback`.
   *   4. If assistantResponseMessageId matches assistantMessageID -> exact match!
   * - SUBMITTED_UNCORRELATED state (sync prompt or no-ID async):
   *   Accepts next terminal assistant turn under ordered fallback.
   *   Emits `recovery_correlation_ordered_fallback`.
   * - A terminal event with an unrelated assistant ID that is NOT the expected response
   *   does NOT complete the generation — recovery remains pending.
   *
   * @param sessionID The session.
   * @param assistantMessageID The terminal assistant turn's message ID.
   * @param assistantParentID Optional parentID from OpenCode metadata (causal correlation).
   */
  public notifyAssistantTurnTerminal(
    sessionID: string,
    assistantMessageID: string,
    assistantParentID?: string,
  ): boolean {
    const genRecord = this.activeGenerations.get(sessionID)
    if (!genRecord) return false
    if (genRecord.state === "TERMINAL" || genRecord.state === "CANCELLED" || genRecord.state === "FAILED") return false

    const wState = getWatchdogState(sessionID)
    if (!wState?.isPendingContinuation) return false

    const internalPromptId = genRecord.internalPromptMessageId

    if (internalPromptId) {
      // 1. Exact causal match: assistant's parentID equals our internal prompt message ID
      if (assistantParentID && assistantParentID === internalPromptId) {
        this._emitTelemetry(genRecord.handleEvent, sessionID, "recovery_correlation_exact", {
          generation: genRecord.generation,
          internalPromptId,
          assistantMessageID,
          assistantParentID,
        })
        return this._completeGeneration(sessionID, genRecord, assistantMessageID)
      }

      // 2. Previously recorded exact assistant response match
      if (genRecord.assistantResponseMessageId && genRecord.assistantResponseMessageId === assistantMessageID) {
        this._emitTelemetry(genRecord.handleEvent, sessionID, "recovery_correlation_exact", {
          generation: genRecord.generation,
          internalPromptId,
          assistantMessageID,
        })
        return this._completeGeneration(sessionID, genRecord, assistantMessageID)
      }

      // 3. Mismatched parentID: parentID is present on assistant message but does NOT match our prompt
      if (assistantParentID && assistantParentID !== internalPromptId) {
        this._emitTelemetry(genRecord.handleEvent, sessionID, "recovery_correlation_rejected", {
          generation: genRecord.generation,
          internalPromptId,
          assistantMessageID,
          assistantParentID,
          reason: "mismatched_parent_id",
        })
        return false
      }

      // 4. Ordered correlation fallback: OpenCode does not populate assistant.parentID.
      // Validated constraints:
      // - generation is currently in RUNNING state
      // - assistant arrived after recovery submission (submittedAt <= Date.now())
      if (!assistantParentID && genRecord.state === "RUNNING") {
        this._emitTelemetry(genRecord.handleEvent, sessionID, "recovery_correlation_ordered_fallback", {
          generation: genRecord.generation,
          internalPromptId,
          assistantMessageID,
        })
        return this._completeGeneration(sessionID, genRecord, assistantMessageID)
      }

      return false
    }

    if (genRecord.state === "SUBMITTED_UNCORRELATED") {
      // Sync prompt or no-ID async — accept next terminal assistant turn under ordered fallback.
      this._emitTelemetry(genRecord.handleEvent, sessionID, "recovery_correlation_ordered_fallback", {
        generation: genRecord.generation,
        assistantMessageID,
        reason: "sync_uncorrelated",
      })
      return this._completeGeneration(sessionID, genRecord, assistantMessageID)
    }

    return false
  }

  private _completeGeneration(sessionID: string, genRecord: RecoveryGeneration, assistantMessageID: string): boolean {
    // Idempotent — if already terminal, do not double-complete
    if (genRecord.state === "TERMINAL") return false
    genRecord.assistantResponseMessageId = assistantMessageID
    genRecord.state = "TERMINAL"
    genRecord.completedAt = Date.now()

    // Cancel orphan timer — generation completed normally
    const orphanTimer = this.orphanTimers.get(sessionID)
    if (orphanTimer) {
      clearTimeout(orphanTimer)
      this.orphanTimers.delete(sessionID)
    }

    updateWatchdogState(sessionID, { isPendingContinuation: false })
    return true
  }

  /**
   * Return the active recovery generation for a session (read-only).
   */
  public getActiveGeneration(sessionID: string): RecoveryGeneration | undefined {
    return this.activeGenerations.get(sessionID)
  }

  /**
   * Notify the coordinator that the assistant turn produced by a recovery generation
   * failed with a provider error (e.g. INVALID_ARGUMENT). This marks the generation
   * FAILED and clears isPendingContinuation, allowing a stage-2 recovery to schedule.
   *
   * This is distinct from cancelSession: the session itself is NOT cancelled, and a
   * stage-2 recovery may still be initiated by the caller after this call returns.
   *
   * @param sessionID The session.
   * @returns true if the generation was active and has been marked FAILED.
   */
  public notifyAssistantTurnProviderError(sessionID: string): boolean {
    const genRecord = this.activeGenerations.get(sessionID)
    if (!genRecord) return false
    if (genRecord.state === "TERMINAL" || genRecord.state === "CANCELLED" || genRecord.state === "FAILED") return false

    const wState = getWatchdogState(sessionID)
    if (!wState?.isPendingContinuation) return false

    genRecord.state = "FAILED"
    genRecord.completedAt = Date.now()

    // Cancel orphan timer
    const orphanTimer = this.orphanTimers.get(sessionID)
    if (orphanTimer) {
      clearTimeout(orphanTimer)
      this.orphanTimers.delete(sessionID)
    }

    updateWatchdogState(sessionID, { isPendingContinuation: false })
    return true
  }

  /**
   * Classify a message event to distinguish manual user follow-ups from internal FlowDeck recovery prompts.
   *
   * Classification order:
   * A. Known message ID → ID-keyed map (permanent, never consumed/one-shot)
   * B. Exact non-empty prompt text AND exactly one pending record → text-match promotion
   * C. Missing/empty text → "unknown_user_event" (never silently classified as internal)
   * D. No match → "manual_user"
   *
   * INVARIANT: empty/missing text NEVER classifies as internal.
   * INVARIANT: once an ID is in the ID map, all events with that ID are internal.
   * INVARIANT: only "manual_user" (positively verified) may reset recovery state.
   * INVARIANT: "unknown_user_event" leaves recovery state unchanged.
   */
  /**
   * Register a coordinator-generated wake-up (parallel_child_ready) as an
   * INTERNAL prompt so classifyMessage() never treats it as a manual user turn.
   * Additive provenance: it cannot reset route/task/recovery state.
   */
  public registerParallelChildReadyPrompt(sessionID: string, messageID: string | undefined, promptText: string): void {
    if (!sessionID || !promptText) return
    let pending = this.pendingPrompts.get(sessionID)
    if (!pending) {
      pending = []
      this.pendingPrompts.set(sessionID, pending)
    }
    const record: InternalPromptRecord = {
      sessionID,
      kind: "internal_parallel_child_ready",
      generation: 0,
      promptText,
      createdAt: Date.now(),
      messageID,
    }
    pending.push(record)
    if (messageID) {
      let byId = this.promptsByMessageId.get(sessionID)
      if (!byId) {
        byId = new Map()
        this.promptsByMessageId.set(sessionID, byId)
      }
      byId.set(messageID, record)
    }
  }

    public classifyMessage(sessionID: string, messageID?: string, text?: string): PromptProvenanceKind {
    if (!sessionID) return "manual_user"

    // A. Check ID-keyed map first — permanent, not consumed
    if (messageID) {
      const byId = this.promptsByMessageId.get(sessionID)
      if (byId?.has(messageID)) {
        return byId.get(messageID)!.kind
      }
    }

    // B/C. Text-based fallback — ONLY for non-empty text
    const trimmedText = text?.trim()
    if (!trimmedText) {
      // Empty or missing text: cannot determine provenance from content alone.
      // Return unknown — do NOT classify as internal based on absence of text.
      return "unknown_user_event"
    }

    const pending = this.pendingPrompts.get(sessionID)
    if (pending && pending.length > 0) {
      // Only match if the text exactly matches the pending internal prompt text.
      // Never use empty text as a wildcard.
      const matchIdx = pending.findIndex((r) => r.promptText.trim() === trimmedText)
      if (matchIdx !== -1) {
        const match = pending[matchIdx]
        // Promote to ID-keyed map if we now have an ID
        if (messageID && !match.messageID) {
          this.promoteToMessageId(sessionID, match, messageID)
          // promoteToMessageId removes from pending — don't splice again
        }
        // Return kind without consuming — the next event with this ID will hit path A
        return match.kind
      }
    }

    return "manual_user"
  }

  /**
   * Mark the current generation as cancelled when a verified manual user message
   * arrives before the prompt is submitted or while pending.
   *
   * Immediately clears active timers, removes pending prompt records, and
   * guarantees isPendingContinuation = false so no stale ownership blocks future work.
   */
  public markGenerationCancelledByUserMessage(sessionID: string): void {
    const genRecord = this.activeGenerations.get(sessionID)
    if (genRecord && (genRecord.state === "SCHEDULED" || genRecord.state === "SUBMITTED_UNCORRELATED")) {
      this._abortGeneration(sessionID, genRecord.generation, undefined, genRecord)
    }
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
    const orphanTimer = this.orphanTimers.get(sessionID)
    if (orphanTimer) {
      clearTimeout(orphanTimer)
      this.orphanTimers.delete(sessionID)
    }
    const genRecord = this.activeGenerations.get(sessionID)
    if (genRecord && genRecord.state !== "TERMINAL" && genRecord.state !== "FAILED") {
      genRecord.state = "CANCELLED"
      genRecord.cancelledAt = Date.now()
    }
    this.pendingPrompts.delete(sessionID)
    this.promptsByMessageId.delete(sessionID)
    this.activeGenerations.delete(sessionID)
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
    for (const timer of this.orphanTimers.values()) {
      clearTimeout(timer)
    }
    this.activeTimers.clear()
    this.orphanTimers.clear()
    this.pendingPrompts.clear()
    this.promptsByMessageId.clear()
    this.activeGenerations.clear()
    this.sessionGenerations.clear()
    this.telemetryListeners.clear()
  }
}

export const recoveryCoordinator = new RecoveryCoordinator()
