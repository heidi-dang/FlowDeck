/**
 * HeidiTaskState — Compact semantic task state externalized from conversation history.
 *
 * Prevents Heidi from reconstructing context from 50–100 historical turns.
 * A small state packet (<200 tokens) is rendered into provider context instead.
 */

// No filesystem imports needed — state is in-memory only

export type ExecutionPhase =
  | "intake"
  | "routing"
  | "context"
  | "execute"
  | "verify"
  | "complete"
  | "blocked"

export type VerificationStatus = "pending" | "running" | "passed" | "failed"

/** Default maximum model turns allowed per child specialist session. */
export const DEFAULT_MAX_CHILD_TURNS = 60

export interface HeidiTaskStateData {
  taskId: string
  goal: string
  executionClass: string
  owner: string
  currentPhase: ExecutionPhase
  /** Confirmed facts discovered during execution (kept short). */
  verifiedFacts: string[]
  /** Files that have been modified by this task. */
  changedFiles: string[]
  /** Active child delegations. */
  pendingChildren: string[]
  /** Hypotheses that were tried and failed (for circuit-breaker). */
  failedHypotheses: string[]
  /** Current blockers preventing progress. */
  blockers: string[]
  /** State of verification. */
  verificationState: VerificationStatus
  /** What the next action should be (compact directive). */
  nextAction?: string
  /**
   * Per-child turn budget: maps child sessionID → turn count.
   * Coordinator checks this on each child heartbeat/completion.
   * When count >= maxChildTurns, coordinator cancels the child and records
   * the partial result to prevent runaway token spend.
   */
  childTurnCounts: Record<string, number>
  /**
   * Maximum model turns allowed per child delegation.
   * Defaults to DEFAULT_MAX_CHILD_TURNS. Set lower for focused tasks.
   */
  maxChildTurns: number
  createdAt: number
  updatedAt: number
}

/** Mutable wrapper with update helpers. */
export class HeidiTaskState {
  private data: HeidiTaskStateData

  constructor(taskId: string, goal: string, executionClass: string, maxChildTurns?: number) {
    const now = Date.now()
    this.data = {
      taskId,
      goal,
      executionClass,
      owner: "heidi",
      currentPhase: "intake",
      verifiedFacts: [],
      changedFiles: [],
      pendingChildren: [],
      failedHypotheses: [],
      blockers: [],
      verificationState: "pending",
      childTurnCounts: {},
      maxChildTurns: maxChildTurns ?? DEFAULT_MAX_CHILD_TURNS,
      createdAt: now,
      updatedAt: now,
    }
  }

  setPhase(phase: ExecutionPhase): void {
    this.data.currentPhase = phase
    this.data.updatedAt = Date.now()
  }

  setOwner(owner: string): void {
    this.data.owner = owner
    this.data.updatedAt = Date.now()
  }

  addVerifiedFact(fact: string): void {
    if (!this.data.verifiedFacts.includes(fact)) {
      this.data.verifiedFacts.push(fact)
      this.data.updatedAt = Date.now()
    }
  }

  addChangedFile(file: string): void {
    if (!this.data.changedFiles.includes(file)) {
      this.data.changedFiles.push(file)
      this.data.updatedAt = Date.now()
    }
  }

  addPendingChild(childId: string): void {
    if (!this.data.pendingChildren.includes(childId)) {
      this.data.pendingChildren.push(childId)
      this.data.updatedAt = Date.now()
    }
  }

  removePendingChild(childId: string): void {
    this.data.pendingChildren = this.data.pendingChildren.filter(c => c !== childId)
    this.data.updatedAt = Date.now()
  }

  /**
   * Record a model turn for a child session.
   * Returns true when the child has exceeded maxChildTurns and should be cancelled.
   */
  incrementChildTurn(childSessionId: string): boolean {
    const count = (this.data.childTurnCounts[childSessionId] ?? 0) + 1
    this.data.childTurnCounts[childSessionId] = count
    this.data.updatedAt = Date.now()
    return count >= this.data.maxChildTurns
  }

  /** Returns the current turn count for a child, or 0 if unknown. */
  getChildTurnCount(childSessionId: string): number {
    return this.data.childTurnCounts[childSessionId] ?? 0
  }

  /** Check if a child has exceeded the per-child turn budget. */
  isChildOverBudget(childSessionId: string): boolean {
    return (this.data.childTurnCounts[childSessionId] ?? 0) >= this.data.maxChildTurns
  }

  addFailedHypothesis(hypothesis: string): void {
    if (!this.data.failedHypotheses.includes(hypothesis)) {
      this.data.failedHypotheses.push(hypothesis)
      this.data.updatedAt = Date.now()
    }
  }

  setBlocker(blocker: string): void {
    if (!this.data.blockers.includes(blocker)) {
      this.data.blockers.push(blocker)
    }
    this.data.currentPhase = "blocked"
    this.data.updatedAt = Date.now()
  }

  clearBlockers(): void {
    this.data.blockers = []
    this.data.updatedAt = Date.now()
  }

  setVerificationState(status: VerificationStatus): void {
    this.data.verificationState = status
    this.data.updatedAt = Date.now()
  }

  setNextAction(action: string): void {
    this.data.nextAction = action
    this.data.updatedAt = Date.now()
  }

  snapshot(): Readonly<HeidiTaskStateData> {
    return { ...this.data, verifiedFacts: [...this.data.verifiedFacts], changedFiles: [...this.data.changedFiles], pendingChildren: [...this.data.pendingChildren], failedHypotheses: [...this.data.failedHypotheses], blockers: [...this.data.blockers] }
  }

  /**
   * Render a compact (<200 token) state packet for provider context injection.
   * Omits empty arrays/fields.
   */
  renderContextPacket(): string {
    const d = this.data
    const lines: string[] = [
      `[TaskState] id:${d.taskId} class:${d.executionClass} phase:${d.currentPhase} verify:${d.verificationState}`,
    ]
    if (d.verifiedFacts.length > 0) {
      lines.push(`Facts: ${d.verifiedFacts.slice(-3).join("; ")}`)
    }
    if (d.changedFiles.length > 0) {
      lines.push(`Changed: ${d.changedFiles.join(", ")}`)
    }
    if (d.pendingChildren.length > 0) {
      lines.push(`AwaitingChildren: ${d.pendingChildren.join(", ")}`)
    }
    if (d.failedHypotheses.length > 0) {
      lines.push(`FailedHypotheses: ${d.failedHypotheses.slice(-2).join("; ")}`)
    }
    if (d.blockers.length > 0) {
      lines.push(`BLOCKED: ${d.blockers.join("; ")}`)
    }
    if (d.nextAction) {
      lines.push(`NextAction: ${d.nextAction}`)
    }
    return lines.join("\n")
  }
}

// Process-level state registry
const _registry = new Map<string, HeidiTaskState>()

export function createTaskState(taskId: string, goal: string, executionClass: string, maxChildTurns?: number): HeidiTaskState {
  const state = new HeidiTaskState(taskId, goal, executionClass, maxChildTurns)
  _registry.set(taskId, state)
  return state
}

export function getTaskState(taskId: string): HeidiTaskState | undefined {
  return _registry.get(taskId)
}

export function clearTaskState(taskId: string): void {
  _registry.delete(taskId)
}

export function _resetAllTaskState(): void {
  _registry.clear()
}
