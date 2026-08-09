/**
 * Token Budget Runtime — plugin-facing integration.
 *
 * Bridges the authoritative TokenBudgetController into OpenCode plugin hooks:
 *
 *  - `onChatMessage`   — pre-dispatch reservation gate. Throws when the run
 *                        or child budget cannot cover the estimated request,
 *                        which aborts the model call BEFORE it is sent.
 *  - `onEvent`         — reconciles a reservation against actual provider
 *                        usage on `message.updated` (AssistantMessage carries
 *                        real `tokens` + `cost`). Idempotent per message id.
 *  - `onSessionEnd`    — releases any still-pending reservations for a session
 *                        when it aborts/errors, so slack is never leaked.
 *
 * One controller exists per run (root session). Child sessions share the
 * parent's run controller but get independently enforced child ceilings.
 */

import { randomUUID } from "crypto"
import { join } from "path"
import { resolveTokenBudgetConfig, type TokenBudgetOverrides } from "../config/token-budget-config"
import { TokenBudgetController, type ReservationResult } from "./token-budget-controller"
import { FileTokenUsageStore } from "./token-usage-store"
import { InMemoryTokenUsageStore, type TokenUsageStore } from "./token-usage-store"
import { AdaptiveExecutionControl } from "./adaptive-execution-control"
import { estimateTokensFromBytes } from "./token-budget"

export interface TokenBudgetRuntimeOptions {
  /** user-supplied tokenBudget config section. */
  overrides?: TokenBudgetOverrides
  /** Directory used for durable accounting when configured. */
  persistDir?: string
  /** Hook for surfacing warnings (e.g. app log). */
  onWarning?: (runId: string, message: string) => void
  /** Hook for surfacing terminal state (e.g. app log). */
  onTerminal?: (runId: string, reason: string) => void
}

export interface SessionBudgetContext {
  sessionID: string
  agent: string
  parentID?: string
  depth: number
}

export interface PreDispatchResult {
  allowed: boolean
  reason?: string
  runId: string
  remainingRun: number
}

interface PendingSlot {
  sessionID: string
  reservationId: string
  requestId: string
}

const MAX_PENDING_PER_SESSION = 8

function serializeEstimate(message: unknown): number {
  try {
    const json = JSON.stringify(message ?? {})
    return estimateTokensFromBytes(Buffer.byteLength(json, "utf-8"))
  } catch {
    return 0
  }
}

export class TokenBudgetRuntime {
  private readonly controllers = new Map<string, TokenBudgetController>()
  private readonly stores = new Map<string, TokenUsageStore>()
  private readonly runForSession = new Map<string, string>() // sessionID → runId
  private readonly pending = new Map<string, PendingSlot[]>() // sessionID → FIFO
  private readonly onWarning?: (runId: string, message: string) => void
  private readonly onTerminal?: (runId: string, reason: string) => void
  private readonly persistDir: string
  private readonly config: ReturnType<typeof resolveTokenBudgetConfig>

  constructor(opts?: TokenBudgetRuntimeOptions) {
    this.onWarning = opts?.onWarning
    this.onTerminal = opts?.onTerminal
    // Persist dir must live outside the project (never committed).
    this.persistDir = opts?.persistDir || ""
    this.config = resolveTokenBudgetConfig(opts?.overrides)
  }

  /** Create a runtime from a FlowDeck config section. */
  static fromConfig(
    config: { tokenBudget?: TokenBudgetOverrides } | undefined,
    opts?: { directory?: string; onWarning?: (runId: string, message: string) => void; onTerminal?: (runId: string, reason: string) => void },
  ): TokenBudgetRuntime {
    let persistDir = config?.tokenBudget?.persistDir ?? ""
    if (!persistDir && opts?.directory) {
      persistDir = join(opts.directory, ".flowdeck", "token-usage")
    }
    return new TokenBudgetRuntime({
      overrides: config?.tokenBudget,
      persistDir,
      onWarning: opts?.onWarning,
      onTerminal: opts?.onTerminal,
    })
  }

  isEnabled(): boolean {
    return this.config.enabled
  }

  getConfig() {
    return this.config
  }

  getControllerForSession(ctx: SessionBudgetContext): TokenBudgetController {
    const existingRun = this.runForSession.get(ctx.sessionID)
    if (existingRun) {
      return this.controllers.get(existingRun)!
    }
    const runId = this.lookupRunId(ctx)
    let ctrl = this.controllers.get(runId)
    if (!ctrl) {
      const store = this.getStore(runId)
      if (this.persistDir) {
        // Recover durable state for the run when present (restart/reconnect).
        const rebuilt = store.rebuild(runId)
        if (rebuilt.consumed > 0 || rebuilt.reserved > 0 || rebuilt.terminal) {
          ctrl = TokenBudgetController.restore(this.config, runId, store)
        } else {
          ctrl = new TokenBudgetController(this.config, { runId, store })
        }
      } else ctrl = new TokenBudgetController(this.config, { runId, store })
      this.controllers.set(runId, ctrl)
    }
    this.runForSession.set(ctx.sessionID, runId)
    ctrl.registerSession(ctx.sessionID, ctx.agent, ctx.parentID)
    return ctrl
  }

  private getStore(runId: string): TokenUsageStore {
    const existing = this.stores.get(runId); if (existing) return existing
    const store = this.persistDir ? new FileTokenUsageStore(this.persistDir) : new InMemoryTokenUsageStore()
    this.stores.set(runId, store); return store
  }

  getAdaptiveControlForSession(ctx: SessionBudgetContext): AdaptiveExecutionControl {
    const controller = this.getControllerForSession(ctx)
    return new AdaptiveExecutionControl(controller, this.getStore(controller.runId))
  }

  private lookupRunId(ctx: SessionBudgetContext): string {
    const direct = this.runForSession.get(ctx.sessionID)
    if (direct) return direct
    if (ctx.parentID) {
      const parentRun = this.runForSession.get(ctx.parentID)
      if (parentRun) return parentRun
      // Recurse upward is not possible without registry access; use parent id
      // as run key so siblings stay coherent within one parent run.
      return ctx.parentID
    }
    return ctx.sessionID
  }

  /**
   * Pre-dispatch gate. Call inside the `chat.message` hook before the model
   * request proceeds. Returns allowed=false (or throws) when the budget
   * cannot cover the estimated request.
   */
  async beforeDispatch(
    ctx: SessionBudgetContext,
    message: unknown,
    opts?: { maxOutputTokens?: number; model?: string; provider?: string },
  ): Promise<PreDispatchResult> {
    const ctrl = this.getControllerForSession(ctx)
    // NOTE: only the message estimate is passed as estimatedInputTokens —
    // the controller adds maxOutputTokens itself (need = input + output).
    // Counting it here too would double-charge every reservation.
    const estimate = serializeEstimate(message)

    const result: ReservationResult = await ctrl.reserveRequest({
      runId: ctrl.runId,
      sessionId: ctx.sessionID,
      agentId: ctx.agent,
      parentSessionId: ctx.parentID,
      requestId: `req-${ctx.sessionID}-${randomUUID()}`,
      estimatedInputTokens: estimate,
      maxOutputTokens: opts?.maxOutputTokens,
      model: opts?.model,
      provider: opts?.provider,
    })

    if (result.disabled) {
      return { allowed: true, runId: ctrl.runId, remainingRun: ctrl.remainingRun() }
    }

    if (result.allowed) {
      const slots = this.pending.get(ctx.sessionID) ?? []
      slots.push({ sessionID: ctx.sessionID, reservationId: result.reservationId, requestId: `req-${ctx.sessionID}` })
      if (slots.length > MAX_PENDING_PER_SESSION) slots.shift()
      this.pending.set(ctx.sessionID, slots)
      if (ctrl.getSnapshot().run.warningFired) {
        this.onWarning?.(ctrl.runId, `Token budget warning: run ${ctrl.runId} used ${ctrl.getSnapshot().run.consumed} of ${ctrl.getSnapshot().run.ceiling}`)
      }
    } else {
      this.onTerminal?.(ctrl.runId, result.reason ?? "budget_exhausted")
    }
    return { allowed: result.allowed, reason: result.reason, runId: ctrl.runId, remainingRun: ctrl.remainingRun() }
  }

  /**
   * Reconcile actual provider usage. Call from the `event` hook on
   * `message.updated` where the assistant message carries real tokens.
   */
  async reconcileUsage(
    ctx: SessionBudgetContext,
    msg: {
      id: string
      tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      cost?: number
      modelID?: string
      providerID?: string
      error?: unknown
    },
  ): Promise<void> {
    const ctrl = this.getControllerForSession(ctx)
    const slot = (this.pending.get(ctx.sessionID) ?? []).shift()
    const tokens = msg.tokens

    await ctrl.commitUsage({
      runId: ctrl.runId,
      sessionId: ctx.sessionID,
      agentId: ctx.agent,
      parentSessionId: ctx.parentID,
      requestId: `req-${ctx.sessionID}`,
      reservationId: slot?.reservationId,
      messageId: msg.id,
      usage: {
        input: tokens?.input,
        output: tokens?.output,
        reasoning: tokens?.reasoning,
        cacheRead: tokens?.cache?.read,
        cacheWrite: tokens?.cache?.write,
        cost: msg.cost,
      },
      model: msg.modelID,
      provider: msg.providerID,
      terminationReason: msg.error ? "message_error" : undefined,
    })

    const snapshot = ctrl.getSnapshot()
    if (snapshot.run.warningFired) {
      this.onWarning?.(ctrl.runId, `Token budget warning: run ${ctrl.runId} used ${snapshot.run.consumed} of ${snapshot.run.ceiling}`)
    }
    if (snapshot.run.terminal) {
      this.onTerminal?.(ctrl.runId, snapshot.run.terminal.reason)
    }
  }

  /** Release all pending reservations for a session on abort/error. */
  async onSessionEnd(ctx: SessionBudgetContext, reason: string): Promise<void> {
    const runId = this.runForSession.get(ctx.sessionID)
    if (!runId) return
    const ctrl = this.controllers.get(runId)
    if (!ctrl) return
    await ctrl.cancelSession(ctx.sessionID, reason)
    this.pending.delete(ctx.sessionID)
  }

  /** Register a session (called once per session creation). */
  registerSession(ctx: SessionBudgetContext): void {
    this.getControllerForSession(ctx)
  }

  getSnapshot(sessionID: string) {
    const runId = this.runForSession.get(sessionID)
    if (!runId) return null
    const ctrl = this.controllers.get(runId)
    return ctrl ? ctrl.getSnapshot() : null
  }

  getControllersForTest(): Map<string, TokenBudgetController> {
    return this.controllers
  }
}
