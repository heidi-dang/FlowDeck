/**
 * SemanticConvergenceGuard — higher-level no-progress detection.
 *
 * Action-level Loop Guard is insufficient: the model can vary operations
 * (`bun test A`, `bun test B`, `grep X`, ...) while semantically doing the
 * same thing for hours. This guard operates on a bounded progress epoch and
 * distinguishes:
 *
 *   ACTIVITY   - tool/model execution
 *   NEW INFORMATION - a materially new verified fact or state change
 *   PROGRESS   - acceptance-criterion advancement
 *   RESOLUTION - deliverable produced / task phase advanced
 *
 * Requirement F + G: semantic no-progress detection even when commands vary,
 * plus resource-burn (context/runaway) detection. The signal is resource burn
 * RELATIVE to semantic progress, never a crude hard token quota.
 */

export interface SemanticConvergenceOptions {
  maxToolCallsSinceProgress?: number
  maxModelTurnsSinceProgress?: number
  maxTokensSinceProgress?: number
  maxRecoveryEventsSinceProgress?: number
  maxGuardBlocksSinceProgress?: number
}

export interface ProgressEpochState {
  meaningfulProgressEpoch: number
  lastProgressAt: number
  toolCallsSinceProgress: number
  modelTurnsSinceProgress: number
  inputTokensSinceProgress: number
  outputTokensSinceProgress: number
  recoveryEventsSinceProgress: number
  guardBlocksSinceProgress: number
  verifiedFacts: string[]
  lastActivityAt: number
  lastEpochStartAt: number
}

export interface SemanticConvergenceCheckResult {
  convergent: boolean
  detectedNoProgress: boolean
  runawayDetected: boolean
  reason?: string
  strategyAdvanceRequired: boolean
  state: ProgressEpochState
}

export type ProgressSignal =
  | "source_changed"
  | "hypothesis_changed"
  | "new_blocker_discovered"
  | "blocker_removed"
  | "reproduction_outcome_changed"
  | "child_task_completed"
  | "verification_advanced"
  | "deliverable_produced"
  | "task_phase_advanced"
  | "new_verified_fact"

const MEANINGFUL_PROGRESS_SIGNALS = new Set<ProgressSignal>([
  "source_changed",
  "hypothesis_changed",
  "new_blocker_discovered",
  "blocker_removed",
  "reproduction_outcome_changed",
  "child_task_completed",
  "verification_advanced",
  "deliverable_produced",
  "task_phase_advanced",
  "new_verified_fact",
])

const NON_PROGRESS_SIGNALS = new Set([
  "same_test_repeat",
  "equivalent_search",
  "reread_same_info",
  "watchdog_prompt",
  "internal_continue",
  "replay_placeholder",
  "synthetic_recovery_marker",
  "rephrased_diagnosis",
  "unit_test_pass_while_live_failing",
])

const DEFAULT_OPTS: Required<SemanticConvergenceOptions> = {
  maxToolCallsSinceProgress: 24,
  maxModelTurnsSinceProgress: 8,
  maxTokensSinceProgress: 400_000,
  maxRecoveryEventsSinceProgress: 3,
  maxGuardBlocksSinceProgress: 3,
}

export class SemanticConvergenceGuard {
  private options: Required<SemanticConvergenceOptions>
  private epochs = new Map<string, ProgressEpochState>()

  constructor(options?: SemanticConvergenceOptions) {
    this.options = { ...DEFAULT_OPTS, ...options }
  }

  private getOrCreate(sessionID: string): ProgressEpochState {
    let state = this.epochs.get(sessionID)
    const now = Date.now()
    if (!state) {
      state = {
        meaningfulProgressEpoch: 1,
        lastProgressAt: now,
        toolCallsSinceProgress: 0,
        modelTurnsSinceProgress: 0,
        inputTokensSinceProgress: 0,
        outputTokensSinceProgress: 0,
        recoveryEventsSinceProgress: 0,
        guardBlocksSinceProgress: 0,
        verifiedFacts: [],
        lastActivityAt: now,
        lastEpochStartAt: now,
      }
      this.epochs.set(sessionID, state)
    }
    return state
  }

  recordToolCall(sessionID: string): void {
    const state = this.getOrCreate(sessionID)
    state.toolCallsSinceProgress++
    state.lastActivityAt = Date.now()
  }

  recordModelTurn(sessionID: string, inputTokens = 0, outputTokens = 0, recovery = false): void {
    const state = this.getOrCreate(sessionID)
    state.modelTurnsSinceProgress++
    state.inputTokensSinceProgress += inputTokens
    state.outputTokensSinceProgress += outputTokens
    state.lastActivityAt = Date.now()
    if (recovery) state.recoveryEventsSinceProgress++
  }

  recordGuardBlock(sessionID: string): void {
    const state = this.getOrCreate(sessionID)
    state.guardBlocksSinceProgress++
  }

  /**
   * A non-progress signal (repeat test, equivalent search, watchdog prompt,
   * internal Continue, replay placeholder, etc.) must NOT reset convergence.
   */
  recordNonProgressSignal(sessionID: string, signal: string): void {
    const state = this.getOrCreate(sessionID)
    state.lastActivityAt = Date.now()
    void signal
  }

  /**
   * Record genuine semantic progress. This is the ONLY thing that resets the
   * no-progress window and advances the epoch.
   */
  recordProgress(sessionID: string, signal: ProgressSignal | string, newFacts?: string[]): void {
    if (!MEANINGFUL_PROGRESS_SIGNALS.has(signal as ProgressSignal)) return
    const state = this.getOrCreate(sessionID)
    state.meaningfulProgressEpoch++
    state.lastProgressAt = Date.now()
    state.toolCallsSinceProgress = 0
    state.modelTurnsSinceProgress = 0
    state.inputTokensSinceProgress = 0
    state.outputTokensSinceProgress = 0
    state.recoveryEventsSinceProgress = 0
    state.guardBlocksSinceProgress = 0
    state.lastEpochStartAt = Date.now()
    if (newFacts) {
      for (const f of newFacts) {
        if (!state.verifiedFacts.includes(f)) state.verifiedFacts.push(f)
      }
    }
  }

  check(sessionID: string): SemanticConvergenceCheckResult {
    const state = this.getOrCreate(sessionID)
    const reasonParts: string[] = []

    const softToolCalls = state.toolCallsSinceProgress >= this.options.maxToolCallsSinceProgress
    const softTurns = state.modelTurnsSinceProgress >= this.options.maxModelTurnsSinceProgress
    const softTokens = state.inputTokensSinceProgress >= this.options.maxTokensSinceProgress
    const softRecovery = state.recoveryEventsSinceProgress >= this.options.maxRecoveryEventsSinceProgress
    const softBlocks = state.guardBlocksSinceProgress >= this.options.maxGuardBlocksSinceProgress

    const burnedSignificantInput = state.inputTokensSinceProgress >= 120_000
    const hasActivityWithoutProgress = (softTurns || softToolCalls) && (softTokens || softRecovery || softBlocks || burnedSignificantInput)

    if (hasActivityWithoutProgress) {
      if (softRecovery || softBlocks) reasonParts.push("repeated recovery/blocks without progress")
      if (softTokens || burnedSignificantInput) {
        reasonParts.push("high input burn (" + state.inputTokensSinceProgress + ") tokens relative to progress")
      }
      if (softTurns) reasonParts.push(state.modelTurnsSinceProgress + " model turns without progress")
      if (softToolCalls) reasonParts.push(state.toolCallsSinceProgress + " tool calls without progress")
      return {
        convergent: false,
        detectedNoProgress: true,
        runawayDetected: burnedSignificantInput && (softTokens || softRecovery),
        reason: reasonParts.join("; "),
        strategyAdvanceRequired: true,
        state: { ...state },
      }
    }

    return {
      convergent: true,
      detectedNoProgress: false,
      runawayDetected: false,
      strategyAdvanceRequired: false,
      state: { ...state },
    }
  }

  getState(sessionID: string): ProgressEpochState | undefined {
    const s = this.epochs.get(sessionID)
    return s ? { ...s } : undefined
  }

  clearSession(sessionID: string): void {
    this.epochs.delete(sessionID)
  }

  clearAll(): void {
    this.epochs.clear()
  }
}

export const semanticConvergenceGuard = new SemanticConvergenceGuard()
export { MEANINGFUL_PROGRESS_SIGNALS, NON_PROGRESS_SIGNALS }
