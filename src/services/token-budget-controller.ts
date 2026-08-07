/**
 * Token Budget Controller
 *
 * One authoritative, runtime-owned hierarchical token-budget model.
 *
 * Hierarchy:
 *   run → agent/session → assignment/delegation → request/attempt
 *
 * Every model invocation is attributable to exactly one run. Budget is
 * enforced BEFORE dispatch via atomic reservation (no check-then-act race),
 * reconciled against actual provider usage afterward, and unused output
 * reservation is released. Concurrent agents cannot oversubscribe the same
 * remaining run budget.
 *
 * Cached-token fields are kept distinct from ordinary uncached input and
 * never double-counted. Missing provider usage falls back conservatively to
 * the reserved estimate so accounting never under-reports.
 */

import { randomUUID } from "crypto"
import type { ResolvedTokenBudgetConfig } from "../config/token-budget-config"
import type { TokenUsageRecord, TokenUsageStore } from "./token-usage-store"
import { InMemoryTokenUsageStore } from "./token-usage-store"

export type TerminalReason = "budget_exhausted" | "cancelled" | "hard_stop" | "disabled"

export interface RawUsage {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
}

export interface NormalizedUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** Conservative billable total. */
  billable: number
  estimatedCost?: number
}

export interface ReserveRequestOptions {
  runId: string
  sessionId: string
  agentId: string
  parentSessionId?: string
  assignmentId?: string
  requestId: string
  attempt?: number
  estimatedInputTokens?: number
  maxOutputTokens?: number
  model?: string
  provider?: string
  contextSize?: number
  messageCount?: number
  toolResultSize?: number
}

export type ReservationStatus = "reserved" | "committed" | "released" | "cancelled" | "disabled"

export interface ReservationResult {
  allowed: boolean
  reservationId: string
  reason?: string
  /** True when budget enforcement is disabled for this run. */
  disabled?: boolean
  remainingRun: number
  claimed: number
}

export interface CommitUsageOptions {
  runId: string
  sessionId: string
  agentId: string
  parentSessionId?: string
  assignmentId?: string
  requestId: string
  reservationId?: string
  messageId?: string
  attempt?: number
  usage: RawUsage
  model?: string
  provider?: string
  terminationReason?: string
}

export interface CommitResult {
  committed: boolean
  releasedUnused: number
  remainingRun: number
  warningFired: boolean
  terminal: { reason: string; at: number } | null
  billable: number
}

export interface TerminalState {
  reason: string
  at: number
}

export interface AgentBudgetState {
  agentId: string
  sessionId: string
  parentSessionId?: string
  ceiling: number
  consumed: number
  reserved: number
  terminal: TerminalState | null
}

export interface AssignmentBudgetState {
  assignmentId: string
  identity: string
  agentId: string
  consumed: number
  reserved: number
  status: "active" | "completed" | "superseded" | "cancelled"
}

export interface RunBudgetState {
  runId: string
  ceiling: number
  consumed: number
  reserved: number
  releasedUnused: number
  warningFired: boolean
  terminal: TerminalState | null
}

export interface TokenBudgetSnapshot {
  runId: string
  profile: string
  enabled: boolean
  run: RunBudgetState
  agents: AgentBudgetState[]
  assignments: AssignmentBudgetState[]
  remainingRun: number
  warningThreshold: number
  hardStopThreshold: number
}

interface ReservationRecord {
  reservationId: string
  runId: string
  sessionId: string
  agentId: string
  parentSessionId?: string
  assignmentId?: string
  requestId: string
  attempt: number
  estimatedInput: number
  maxOutput: number
  claimed: number
  status: ReservationStatus
  committedAt?: string
}

/** In-process mutex — serialises all budget mutations (no check-then-act race). */
class InProcessMutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>(r => {
      release = r
    })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function finiteOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function finiteOrZero(v: unknown, fallback = 0): number {
  return finiteOr(v, fallback)
}

/**
 * Normalise provider usage. Cached tokens stay distinct from uncached input.
 * Missing input falls back conservatively to the reserved estimate so a
 * provider that omits usage data is never under-accounted.
 */
export function normalizeUsage(raw: RawUsage, fallbackInput = 0): NormalizedUsage {
  const input = finiteOrZero(raw.input, fallbackInput)
  const output = finiteOrZero(raw.output, 0)
  const reasoning = finiteOrZero(raw.reasoning, 0)
  const cacheRead = finiteOrZero(raw.cacheRead, 0)
  const cacheWrite = finiteOrZero(raw.cacheWrite, 0)
  const billable = input + output + reasoning + cacheRead + cacheWrite
  const cost = typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : undefined
  return { input, output, reasoning, cacheRead, cacheWrite, billable, estimatedCost: cost }
}

export class TokenBudgetController {
  private readonly config: ResolvedTokenBudgetConfig
  private readonly store: TokenUsageStore
  private readonly mutex = new InProcessMutex()

  private run: RunBudgetState
  private readonly agents = new Map<string, AgentBudgetState>()
  private readonly assignments = new Map<string, AssignmentBudgetState>()
  private readonly reservations = new Map<string, ReservationRecord>()
  private readonly records: TokenUsageRecord[] = []
  private readonly committedKeys = new Set<string>()

  constructor(config: ResolvedTokenBudgetConfig, opts?: { store?: TokenUsageStore; runId?: string }) {
    this.config = config
    this.store = opts?.store ?? new InMemoryTokenUsageStore()
    this.run = {
      runId: opts?.runId ?? randomUUID(),
      ceiling: config.runTotal,
      consumed: 0,
      reserved: 0,
      releasedUnused: 0,
      warningFired: false,
      terminal: null,
    }
  }

  get runId(): string {
    return this.run.runId
  }

  get configValue(): ResolvedTokenBudgetConfig {
    return this.config
  }

  /** Restore a controller from durable state (restart/recovery). */
  static restore(
    config: ResolvedTokenBudgetConfig,
    runId: string,
    store: TokenUsageStore,
  ): TokenBudgetController {
    const ctrl = new TokenBudgetController(config, { store, runId })
    const rebuilt = store.rebuild(runId)
    ctrl.run.consumed = rebuilt.consumed
    ctrl.run.reserved = rebuilt.reserved
    ctrl.run.releasedUnused = rebuilt.releasedUnused
    ctrl.run.warningFired = rebuilt.warningFired
    ctrl.run.terminal = rebuilt.terminal
    for (const rec of rebuilt.records) {
      ctrl.records.push(rec)
      const key = rec.messageId ?? rec.requestId ?? rec.reservationId ?? ""
      if (key) ctrl.committedKeys.add(key)
    }
    return ctrl
  }

  // ─── Session / agent registration ─────────────────────────────────────

  registerSession(sessionId: string, agentId: string, parentSessionId?: string): AgentBudgetState {
    const existing = this.agents.get(sessionId)
    if (existing) return existing
    const ceiling = Math.min(this.config.childTotal, this.run.ceiling)
    const state: AgentBudgetState = {
      agentId,
      sessionId,
      parentSessionId,
      ceiling,
      consumed: 0,
      reserved: 0,
      terminal: null,
    }
    this.agents.set(sessionId, state)
    return state
  }

  // ─── Assignment deduplication (Phase M) ─────────────────────────────────

  /**
   * Derive a stable assignment identity from run + assignment type + agent +
   * scope + repository SHA. Equivalent active/completed assignments are
   * reused rather than duplicated.
   */
  static assignmentIdentity(runId: string, assignmentType: string, agentId: string, scope: string, sha: string): string {
    return [runId, assignmentType, agentId, scope, sha].join("|")
  }

  ensureAssignment(
    agentId: string,
    assignmentType: string,
    scope: string,
    sha: string,
  ): { assignmentId: string; reused: boolean; existing: AssignmentBudgetState | null } {
    const identity = TokenBudgetController.assignmentIdentity(this.run.runId, assignmentType, agentId, scope, sha)
    for (const a of this.assignments.values()) {
      if (a.identity === identity && a.status === "active") {
        return { assignmentId: a.assignmentId, reused: true, existing: a }
      }
    }
    const assignmentId = randomUUID()
    this.assignments.set(assignmentId, {
      assignmentId,
      identity,
      agentId,
      consumed: 0,
      reserved: 0,
      status: "active",
    })
    return { assignmentId, reused: false, existing: null }
  }

  completeAssignment(assignmentId: string): void {
    const a = this.assignments.get(assignmentId)
    if (a && a.status === "active") a.status = "completed"
  }

  supersedeAssignment(assignmentId: string): void {
    const a = this.assignments.get(assignmentId)
    if (a && a.status === "active") a.status = "superseded"
  }

  // ─── Dispatch gate (Phase C) ─────────────────────────────────────────────

  /**
   * Atomically reserve budget for a model request BEFORE dispatch.
   * Rejects when insufficient budget remains. Concurrent callers cannot
   * oversubscribe the same remaining run budget.
   */
  async reserveRequest(opts: ReserveRequestOptions): Promise<ReservationResult> {
    return this.mutex.run(() => this.reserveRequestSync(opts))
  }

  private reserveRequestSync(opts: ReserveRequestOptions): ReservationResult {
    const reservationId = randomUUID()
    const attempt = opts.attempt ?? 1

    if (!this.config.enabled) {
      this.records.push(this.buildRecord(opts, reservationId, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, billable: 0 }, "disabled"))
      return { allowed: true, reservationId, disabled: true, remainingRun: this.remainingRun(), claimed: 0 }
    }

    if (this.run.terminal) {
      this.records.push(this.buildRecord(opts, reservationId, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, billable: 0 }, "rejected", this.run.terminal.reason))
      return { allowed: false, reservationId, reason: `RUN_TERMINAL:${this.run.terminal.reason}`, remainingRun: this.remainingRun(), claimed: 0 }
    }

    const agent = this.agents.get(opts.sessionId) ?? this.registerSession(opts.sessionId, opts.agentId, opts.parentSessionId)
    if (agent.terminal) {
      this.records.push(this.buildRecord(opts, reservationId, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, billable: 0 }, "rejected", agent.terminal.reason))
      return { allowed: false, reservationId, reason: `SESSION_TERMINAL:${agent.terminal.reason}`, remainingRun: this.remainingRun(), claimed: 0 }
    }

    const estimatedInput = clamp(finiteOrZero(opts.estimatedInputTokens, 0), 0, this.config.maxRequestInputTokens)
    const maxOutput = clamp(finiteOrZero(opts.maxOutputTokens, 0), 0, this.config.maxRequestOutputTokens)
    const need = estimatedInput + maxOutput

    const remainingRun = this.remainingRun()
    if (need > remainingRun) {
      this.records.push(this.buildRecord(opts, reservationId, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, billable: 0 }, "rejected", "budget_exhausted"))
      return { allowed: false, reservationId, reason: "BUDGET_EXHAUSTED", remainingRun, claimed: 0 }
    }

    const remainingAgent = agent.ceiling - agent.consumed - agent.reserved
    if (need > remainingAgent) {
      this.records.push(this.buildRecord(opts, reservationId, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, billable: 0 }, "rejected", "child_budget_exhausted"))
      return { allowed: false, reservationId, reason: "CHILD_BUDGET_EXHAUSTED", remainingRun, claimed: 0 }
    }

    // Atomic claim against run + agent (+ assignment).
    this.run.reserved += need
    agent.reserved += need
    const assignment = opts.assignmentId ? this.assignments.get(opts.assignmentId) : undefined
    if (assignment) assignment.reserved += need

    const record: ReservationRecord = {
      reservationId,
      runId: this.run.runId,
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      parentSessionId: opts.parentSessionId,
      assignmentId: opts.assignmentId,
      requestId: opts.requestId,
      attempt,
      estimatedInput,
      maxOutput,
      claimed: need,
      status: "reserved",
    }
    this.reservations.set(reservationId, record)
    this.store.append(this.run.runId, { kind: "reservation", ...record })

    return { allowed: true, reservationId, remainingRun: this.remainingRun(), claimed: need }
  }

  // ─── Reconcile (Phase C step 7-9) ───────────────────────────────────────

  /**
   * Reconcile a reservation against actual provider usage. Releases unused
   * output reservation and records the authoritative usage event. Idempotent
   * per messageId/requestId.
   */
  async commitUsage(opts: CommitUsageOptions): Promise<CommitResult> {
    return this.mutex.run(async () => this.commitUsageSync(opts))
  }

  private commitUsageSync(opts: CommitUsageOptions): CommitResult {
    const dedupKey = opts.messageId ?? opts.requestId
    if (dedupKey && this.committedKeys.has(dedupKey)) {
      return {
        committed: false,
        releasedUnused: 0,
        remainingRun: this.remainingRun(),
        warningFired: this.run.warningFired,
        terminal: this.run.terminal,
        billable: 0,
      }
    }

    const reservation = opts.reservationId ? this.reservations.get(opts.reservationId) : undefined
    const fallbackInput = reservation?.estimatedInput ?? 0
    const usage = normalizeUsage(opts.usage, fallbackInput)

    // Release the reservation's unused portion.
    let releasedUnused = 0
    if (reservation && reservation.status === "reserved") {
      reservation.status = "committed"
      reservation.committedAt = new Date().toISOString()
      releasedUnused = Math.max(0, reservation.claimed - usage.billable)
      this.run.reserved = Math.max(0, this.run.reserved - reservation.claimed)
      this.run.releasedUnused += releasedUnused
      const agent = this.agents.get(opts.sessionId)
      if (agent) agent.reserved = Math.max(0, agent.reserved - reservation.claimed)
      const assignment = reservation.assignmentId ? this.assignments.get(reservation.assignmentId) : undefined
      if (assignment) assignment.reserved = Math.max(0, assignment.reserved - reservation.claimed)
    }

    // Charge actual usage.
    this.run.consumed += usage.billable
    const agent = this.agents.get(opts.sessionId) ?? this.registerSession(opts.sessionId, opts.agentId, opts.parentSessionId)
    agent.consumed += usage.billable
    const assignment = reservation?.assignmentId ? this.assignments.get(reservation.assignmentId) : undefined
    if (assignment) assignment.consumed += usage.billable

    if (dedupKey) this.committedKeys.add(dedupKey)

    const record = this.buildRecord(
      {
        runId: opts.runId,
        sessionId: opts.sessionId,
        agentId: opts.agentId,
        parentSessionId: opts.parentSessionId,
        assignmentId: opts.assignmentId,
        requestId: opts.requestId,
        attempt: opts.attempt ?? reservation?.attempt ?? 1,
        model: opts.model,
        provider: opts.provider,
      },
      reservation?.reservationId ?? "",
      usage,
      "committed",
      opts.terminationReason,
      opts.messageId,
    )
    this.records.push(record)
    this.store.append(this.run.runId, { kind: "usage", ...record })

    // Warning fires once.
    let warningFired = false
    if (!this.run.warningFired && this.run.consumed >= this.config.warningThreshold * this.run.ceiling) {
      this.run.warningFired = true
      warningFired = true
      this.store.append(this.run.runId, { kind: "warning", runId: this.run.runId, at: Date.now() })
    }

    // Hard stop.
    let terminal = this.run.terminal
    if (!terminal && this.run.consumed >= this.config.hardStopThreshold * this.run.ceiling) {
      terminal = { reason: "budget_exhausted", at: Date.now() }
      this.run.terminal = terminal
      this.store.append(this.run.runId, { kind: "terminal", reason: terminal.reason, at: terminal.at })
      this.cancelAllReservations("budget_exhausted")
    }

    return {
      committed: true,
      releasedUnused,
      remainingRun: this.remainingRun(),
      warningFired,
      terminal,
      billable: usage.billable,
    }
  }

  // ─── Cancellation / terminal (Phase I) ──────────────────────────────────

  async terminate(reason: string): Promise<void> {
    return this.mutex.run(async () => {
      if (this.run.terminal) return
      this.run.terminal = { reason, at: Date.now() }
      this.store.append(this.run.runId, { kind: "terminal", reason, at: this.run.terminal.at })
      this.cancelAllReservations(reason)
      for (const a of this.agents.values()) {
        if (!a.terminal) a.terminal = { reason, at: this.run.terminal.at }
      }
    })
  }

  async cancelSession(sessionId: string, reason: string): Promise<void> {
    return this.mutex.run(async () => {
      const agent = this.agents.get(sessionId)
      if (agent && !agent.terminal) {
        agent.terminal = { reason, at: Date.now() }
      }
      // Propagate to descendants.
      for (const a of this.agents.values()) {
        if (a.parentSessionId === sessionId && !a.terminal) {
          a.terminal = { reason, at: Date.now() }
        }
      }
      // Cancel reservations owned by this session and its descendants.
      const affected = new Set<string>([sessionId])
      for (const a of this.agents.values()) {
        if (a.parentSessionId === sessionId) affected.add(a.sessionId)
      }
      for (const r of this.reservations.values()) {
        if (r.status === "reserved" && affected.has(r.sessionId)) {
          r.status = "cancelled"
          this.run.reserved = Math.max(0, this.run.reserved - r.claimed)
          const ag = this.agents.get(r.sessionId)
          if (ag) ag.reserved = Math.max(0, ag.reserved - r.claimed)
        }
      }
    })
  }

  private cancelAllReservations(_reason: string): void {
    for (const r of this.reservations.values()) {
      if (r.status === "reserved") {
        r.status = "cancelled"
        this.run.reserved = Math.max(0, this.run.reserved - r.claimed)
        const ag = this.agents.get(r.sessionId)
        if (ag) ag.reserved = Math.max(0, ag.reserved - r.claimed)
      }
    }
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  isRunTerminal(): boolean {
    return this.run.terminal !== null
  }

  isSessionTerminal(sessionId: string): boolean {
    return this.agents.get(sessionId)?.terminal !== null
  }

  remainingRun(): number {
    return Math.max(0, this.run.ceiling - this.run.consumed - this.run.reserved)
  }

  canDispatch(sessionId: string, estimatedInputTokens: number, maxOutputTokens: number): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: true }
    if (this.run.terminal) return { allowed: false, reason: `RUN_TERMINAL:${this.run.terminal.reason}` }
    const agent = this.agents.get(sessionId)
    if (agent?.terminal) return { allowed: false, reason: `SESSION_TERMINAL:${agent.terminal.reason}` }
    const need = clamp(finiteOrZero(estimatedInputTokens, 0), 0, this.config.maxRequestInputTokens) +
      clamp(finiteOrZero(maxOutputTokens, 0), 0, this.config.maxRequestOutputTokens)
    if (need > this.remainingRun()) return { allowed: false, reason: "BUDGET_EXHAUSTED" }
    if (agent) {
      const remainingAgent = agent.ceiling - agent.consumed - agent.reserved
      if (need > remainingAgent) return { allowed: false, reason: "CHILD_BUDGET_EXHAUSTED" }
    }
    return { allowed: true }
  }

  getSnapshot(): TokenBudgetSnapshot {
    return {
      runId: this.run.runId,
      profile: this.config.profile,
      enabled: this.config.enabled,
      run: { ...this.run },
      agents: [...this.agents.values()].map(a => ({ ...a })),
      assignments: [...this.assignments.values()].map(a => ({ ...a })),
      remainingRun: this.remainingRun(),
      warningThreshold: this.config.warningThreshold,
      hardStopThreshold: this.config.hardStopThreshold,
    }
  }

  getUsageRecords(): TokenUsageRecord[] {
    return [...this.records]
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  persist(): void {
    // Records are appended eagerly; this is a no-op flush hook for symmetry.
    this.store.append(this.run.runId, { kind: "terminal", reason: "flush", at: Date.now() })
  }

  private buildRecord(
    opts: {
      runId: string
      sessionId: string
      agentId: string
      parentSessionId?: string
      assignmentId?: string
      requestId: string
      attempt?: number
      model?: string
      provider?: string
    },
    reservationId: string,
    usage: NormalizedUsage,
    status: TokenUsageRecord["status"],
    terminationReason?: string,
    messageId?: string,
  ): TokenUsageRecord {
    return {
      runId: opts.runId,
      sessionId: opts.sessionId,
      parentSessionId: opts.parentSessionId,
      assignmentId: opts.assignmentId,
      agent: opts.agentId,
      model: opts.model,
      provider: opts.provider,
      requestId: opts.requestId,
      reservationId,
      messageId,
      attempt: opts.attempt ?? 1,
      input: usage.input,
      output: usage.output,
      reasoning: usage.reasoning,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      billable: usage.billable,
      estimatedCost: usage.estimatedCost,
      terminationReason,
      status,
      recordedAt: new Date().toISOString(),
    }
  }
}