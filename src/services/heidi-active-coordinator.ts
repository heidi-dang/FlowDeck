/**
 * Heidi Active Coordinator — root orchestration policy over the existing child
 * lifecycle (Roadmap item 2).
 *
 * This service does NOT execute child processes and does NOT invoke an LLM.
 * It controls the root coordination policy: fan-out reconciliation, coordinator
 * ownership rules, the READY result queue, immediate incremental integration,
 * and the final convergence barrier — deterministically.
 *
 * The DSH behavioral reference it encodes:
 *   desired=4 / observed=1  ->  reconcile -> launch B/C/D (never A twice)
 *   B READY while A/C/D run ->  next directive = review B  (not wait)
 *   no READY result        ->  useful non-conflicting coordinator work
 *   final all-child wait    ->  only at FINAL_CONVERGENCE
 */

import {
  assertDisjointWrites,
  canRootWrite,
  findOwnershipConflicts,
  type ParallelWorkstreamOwnership,
  type CoordinatorOwnership,
} from "./heidi-parallel-ownership"
import { isTerminalChildState, type ChildLifecyclePort, type ChildSnapshot } from "./child-lifecycle-port"

export type CoordinatorPhase =
  | "fanout_reconcile"
  | "coordinator_active"
  | "incremental_integration"
  | "final_convergence"
  | "complete"

export type IntegrationStatus =
  | "pending"
  | "ready"
  | "reviewing"
  | "integrating"
  | "focused_verification"
  | "integrated"
  | "rejected"

export type ContractState = "unknown" | "materializing" | "stable"

export type CoordinatorDirectiveKind =
  | "integrate_ready"
  | "launch_missing"
  | "coordinator_work"
  | "unblock"
  | "reconcile"
  | "wait"

export type CoordinatorWorkCategory =
  | "integration_architecture"
  | "central_integration_inspection"
  | "caller_callee_inspection"
  | "acceptance_criteria_refinement"
  | "combined_test_planning"
  | "ci_platform_implication"
  | "api_compatibility_analysis"
  | "dependency_risk_investigation"
  | "prefetch_integration_files"
  | "root_owned_implementation"

export interface CoordinatorDirective {
  kind: CoordinatorDirectiveKind
  nodeId?: string
  workstreamId?: string
  specialist?: string
  category?: CoordinatorWorkCategory
  reason?: string
}

export interface DesiredChild {
  workstreamId: string
  specialist: string
  goal: string
  access?: "read" | "write"
  fileScopes?: string[]
  priority?: number
}

export interface ParallelIntegrationState {
  nodeId: string
  status: IntegrationStatus
  contract?: ContractState
  declaredContract?: {
    exports: string[]
    ownFiles: string[]
    expectedResultShape?: string[]
    sinceMs: number
  }
  contractInvalidated?: boolean
  resultReadyAt?: number
  reviewStartedAt?: number
  integrationStartedAt?: number
  integratedAt?: number
}

export interface ActiveCoordinatorMetrics {
  parallelWorkersRequested: number
  parallelWorkersStarted: number
  fanoutReconcileMs: number
  coordinatorUsefulWorkMs: number
  coordinatorIdleWhileChildrenActiveMs: number
  coordinatorUsefulWorkRatio: number
  childStatusEvents: number
  reconciliationPolls: number
  pollModelTurns: number
  childResultReadyToReviewMs: number
  childResultReadyToIntegrateMs: number
  integrationOverlapMs: number
  awaitAllBarrierMs: number
  ownershipConflicts: number
  workDuplicationEvents: number
  missedReadyResultCount: number
  launchDirectivesIssued: number
}

const COORDINATOR_WORK_CATEGORIES: CoordinatorWorkCategory[] = [
  "integration_architecture",
  "central_integration_inspection",
  "caller_callee_inspection",
  "acceptance_criteria_refinement",
  "combined_test_planning",
  "ci_platform_implication",
  "api_compatibility_analysis",
  "dependency_risk_investigation",
  "prefetch_integration_files",
  "root_owned_implementation",
]

export class HeidiActiveCoordinator {
  private parentSessionId: string
  private runId: string
  private goal: string
  private phase: CoordinatorPhase = "fanout_reconcile"
  private desired = new Map<string, DesiredChild>()
  private ownership = new Map<string, ParallelWorkstreamOwnership>()
  private coordinatorOwnership: CoordinatorOwnership
  private observed = new Map<string, ChildSnapshot>() // childId -> snapshot (by workstreamId key)
  private observedRawIds = new Set<string>()
  private inflated = new Set<string>()
  private lastDirectiveAt = new Map<string, number>()
  private integration = new Map<string, ParallelIntegrationState>()
  private coordinatorWorkIndex = 0
  private readyQueue: string[] = []
  private port?: ChildLifecyclePort
  private parentChildKey: string
  private metrics: ActiveCoordinatorMetrics
  private fanoutStartAt = 0
  private lastReconcileAt = 0
  private readonly relaunchWindowMs: number

  constructor(input: {
    parentSessionId: string
    runId: string
    goal: string
    coordinatorOwnership?: CoordinatorOwnership
    children?: DesiredChild[]
    port?: ChildLifecyclePort
    relaunchWindowMs?: number
  }) {
    this.parentSessionId = input.parentSessionId
    this.runId = input.runId
    this.goal = input.goal
    this.parentChildKey = input.parentSessionId + ":" + input.runId
    this.coordinatorOwnership = input.coordinatorOwnership ?? { integrationScopes: ["src/index.ts"], readScopes: ["src/**"] }
    this.port = input.port
    this.relaunchWindowMs = input.relaunchWindowMs ?? 10_000
    this.metrics = {
      parallelWorkersRequested: 0,
      parallelWorkersStarted: 0,
      fanoutReconcileMs: 0,
      coordinatorUsefulWorkMs: 0,
      coordinatorIdleWhileChildrenActiveMs: 0,
      coordinatorUsefulWorkRatio: 0,
      childStatusEvents: 0,
      reconciliationPolls: 0,
      pollModelTurns: 0,
      childResultReadyToReviewMs: 0,
      childResultReadyToIntegrateMs: 0,
      integrationOverlapMs: 0,
      awaitAllBarrierMs: 0,
      ownershipConflicts: 0,
      workDuplicationEvents: 0,
      missedReadyResultCount: 0,
      launchDirectivesIssued: 0,
    }
    if (input.children && input.children.length > 0) {
      this.registerDesiredChildren(input.children)
    }
  }

  getParentKey(): string {
    return this.parentChildKey
  }

  getRunId(): string {
    return this.runId
  }

  getPhase(): CoordinatorPhase {
    return this.phase
  }

  /** Register the desired children; validates disjoint write scopes before start. */
  registerDesiredChildren(children: DesiredChild[]): { workersRequested: number; conflicts: string[] } {
    for (const c of children) {
      this.desired.set(c.workstreamId, c)
      if (c.access !== undefined) {
        const existing = this.ownership.get(c.workstreamId)
        this.ownership.set(c.workstreamId, {
          workstreamId: c.workstreamId,
          agent: c.specialist,
          access: c.access,
          ownedScopes: c.fileScopes ?? [],
          forbiddenScopes: [],
          expectedOutputs: [],
        })
        void existing
      }
    }
    const writeChildren = Array.from(this.ownership.values())
    this.metrics.parallelWorkersRequested = this.desired.size
    let conflicts: string[] = []
    try {
      assertDisjointWrites(writeChildren)
    } catch (err) {
      const found = findOwnershipConflicts(writeChildren)
      this.metrics.ownershipConflicts = found.length
      conflicts = found.map((c) => c.a + "~" + c.b + ":" + c.scope)
      throw err
    }
    return { workersRequested: this.desired.size, conflicts }
  }

  getDesired(): DesiredChild[] {
    return Array.from(this.desired.values())
  }

  /** Mark a workstream as launched (so reconcile never re-launches it). */
  markLaunched(workstreamId: string): void {
    this.inflated.add(workstreamId)
    this.metrics.parallelWorkersStarted = Math.max(this.metrics.parallelWorkersStarted, this.inflated.size)
    this.lastDirectiveAt.set(workstreamId, Date.now())
  }

  /**
   * Reconcile desired vs observed. Deterministic:
   *   missing    = desired not observed
   *   duplicates = observed childSession that is not a desired workstream (or observed twice)
   * Launch directives only for missing workstreams NOT already inflated, or missing
   * beyond the relaunch window (bounded recovery of dropped launches).
   */
  reconcileChildren(observed: ChildSnapshot[]): {
    missing: string[]
    duplicates: string[]
    launchDirectives: Array<{ workstreamId: string; specialist: string; goal: string }>
  } {
    const t0 = Date.now()
    if (this.fanoutStartAt === 0) this.fanoutStartAt = t0
    this.observedRawIds.clear()
    for (const snap of observed) {
      this.observedRawIds.add(snap.childId)
      // Match a child to a desired workstream by its childId (stable id) OR by
      // specialist only when childId doesn't collide.
      if (this.desired.has(snap.childId)) {
        this.observed.set(snap.childId, snap)
      } else {
        this.observed.set(snap.childId, snap)
      }
    }
    this.metrics.reconciliationPolls++

    const duplicateSource = observed.filter((s) => {
      return !Array.from(this.desired.keys()).includes(s.childId) && !s.childId.startsWith(this.runId)
    })
    const missing = Array.from(this.desired.keys()).filter((ws) => !this.observed.has(ws))

    const launchDirectives: Array<{ workstreamId: string; specialist: string; goal: string }> = []
    const now = Date.now()
    for (const ws of missing) {
      const child = this.desired.get(ws)
      if (!child) continue
      const last = this.lastDirectiveAt.get(ws)
      // Emit once, then suppress until the bounded relaunch window (dropped-launch recovery).
      const canRelaunch = last === undefined || now - last > this.relaunchWindowMs
      if (canRelaunch) {
        launchDirectives.push({ workstreamId: ws, specialist: child.specialist, goal: child.goal })
        this.lastDirectiveAt.set(ws, now)
      }
    }
    if (launchDirectives.length > 0) this.metrics.launchDirectivesIssued += launchDirectives.length

    this.metrics.fanoutReconcileMs += Date.now() - t0
    return {
      missing,
      duplicates: Array.from(new Set(duplicateSource.map((s) => s.childId))),
      launchDirectives,
    }
  }

  /** Event-driven child update: low-latency, no poll required. */
  recordChildLifecycleEvent(event: { childId: string; kind?: string; snapshot: ChildSnapshot }): void {
    this.metrics.childStatusEvents++
    this.observed.set(event.childId, event.snapshot)
    const workerStarted = this.observed.has(event.childId)
    if (workerStarted && !this.inflated.has(event.childId)) {
      this.inflated.add(event.childId)
      this.metrics.parallelWorkersStarted = Math.max(this.metrics.parallelWorkersStarted, this.inflated.size)
    }
    if (event.kind === "child.failed" || event.kind === "child.cancelled") {
      const st = this.integration.get(event.childId)
      if (st && st.status !== "integrated" && st.status !== "rejected") this.integration.set(event.childId, { ...st, status: "rejected" })
    }
    if (event.kind === "child.completed" || (isTerminalChildState(event.snapshot.state) && event.snapshot.state === "completed")) {
      this.markResultReady(event.childId, event.snapshot.finishedAt ?? event.snapshot.createdAt)
    }
    if (event.kind === "child.contract_ready") {
      this.markContractStable(event.childId, {})
      this.integration.set(event.childId, {
        ...(this.integration.get(event.childId) ?? { nodeId: event.childId, status: "pending" }),
        contract: "stable",
      })
    }
  }

  /** A completed child with a valid result becomes READY and is enqueued. */
  markResultReady(nodeId: string, completedAt?: number): void {
    const now = completedAt ?? Date.now()
    const existing = this.integration.get(nodeId) ?? { nodeId, status: "pending" }
    if (existing.status === "ready" || existing.status === "integrated" || existing.status === "reviewing") return
    this.integration.set(nodeId, { ...existing, status: "ready", resultReadyAt: existing.resultReadyAt ?? now })
    if (!this.readyQueue.includes(nodeId)) this.readyQueue.push(nodeId)
    this.sortReadyQueue()
    if (this.phase !== "final_convergence" && this.phase !== "complete") this.phase = "incremental_integration"
  }

  private sortReadyQueue(): void {
    const desiredList = Array.from(this.desired.values())
    const depCount = new Map<string, number>()
    for (const c of desiredList) depCount.set(c.workstreamId, 0)
    for (const c of desiredList) if (c.workstreamId) depCount.set(c.workstreamId, (depCount.get(c.workstreamId) ?? 0))
    // deterministic: priority desc, then completedAt asc, then id tie-break
    this.readyQueue.sort((x, y) => {
      const dx = this.desired.get(x)
      const dy = this.desired.get(y)
      const px = dx?.priority ?? 0
      const py = dy?.priority ?? 0
      if (py !== px) return py - px
      const rx = this.integration.get(x)?.resultReadyAt ?? 0
      const ry = this.integration.get(y)?.resultReadyAt ?? 0
      if (rx !== ry) return rx - ry
      return x.localeCompare(y)
    })
  }

  getReadyResults(): string[] {
    return this.readyQueue.filter((id) => {
      const st = this.integration.get(id)?.status
      return st === "ready"
    })
  }

  /** Deterministic next directive for the root (never an LLM call). */
  nextCoordinatorDirective(): CoordinatorDirective {
    // 1. READY result that can integrate now.
    const ready = this.getReadyResults()
    if (ready.length > 0) {
      this.phase = "incremental_integration"
      return { kind: "integrate_ready", nodeId: ready[0], workstreamId: ready[0], reason: "readiest child result ready to review" }
    }

    // 2. Missing child from the intended fan-out.
    const missing = Array.from(this.desired.keys()).filter((ws) => !this.observed.has(ws))
    if (this.phase === "fanout_reconcile" || missing.length > 0) {
      const target = missing.find((ws) => !this.inflated.has(ws)) ?? missing[0]
      if (target) {
        const child = this.desired.get(target)
        this.lastDirectiveAt.set(target, Date.now())
        return { kind: "launch_missing", workstreamId: target, specialist: child?.specialist, reason: "intended child not yet started" }
      }
    }

    // 3. Coordinator-owned useful work (rotate deterministically through the fixed categories).
    const activeChildren = Array.from(this.observed.values()).filter((s) => !isTerminalChildState(s.state))
    if (activeChildren.length > 0 && this.coordinatorOwnership.integrationScopes.length > 0) {
      this.phase = this.phase === "incremental_integration" ? this.phase : "coordinator_active"
      const category = COORDINATOR_WORK_CATEGORIES[this.coordinatorWorkIndex % COORDINATOR_WORK_CATEGORIES.length]
      this.coordinatorWorkIndex++
      this.metrics.coordinatorUsefulWorkMs += 1 // account for directive emission (measure separately in live path)
      return { kind: "coordinator_work", category, reason: "children active; non-conflicting coordinator work available" }
    }

    // 4. Dependency-unblocking work.
    const blockedUs = Array.from(this.observed.values()).filter((s) => s.state === "completed")
    if (blockedUs.length > 0 && ready.length === 0) {
      // nothing more to review; fall through
    }

    // 5. Cheap reconciliation if due.
    const now = Date.now()
    if (now - this.lastReconcileAt > this.reconcileIntervalMs()) {
      this.lastReconcileAt = now
      return { kind: "reconcile", reason: "cheap child-status reconciliation due" }
    }

    // 6. Genuine wait only if nothing better exists.
    return { kind: "wait", reason: "no ready result, no safe coordinator work, no work to reconcile" }
  }

  private reconcileIntervalMs(): number {
    const active = Array.from(this.observed.values()).filter((s) => !isTerminalChildState(s.state)).length
    if (active === 0) return 30_000
    const recentlyTransitioned = Array.from(this.observed.values()).some((s) => Date.now() - s.lastActivityAt < 5_000)
    if (recentlyTransitioned) return 5_000
    return 20_000
  }

  markReviewing(nodeId: string): void {
    const st = this.integration.get(nodeId) ?? { nodeId, status: "ready" }
    this.integration.set(nodeId, { ...st, status: "reviewing", reviewStartedAt: st.reviewStartedAt ?? Date.now() })
    this.metrics.childResultReadyToReviewMs = Math.max(0, Date.now() - (st.resultReadyAt ?? Date.now()))
  }

  markIntegrating(nodeId: string): void {
    const st = this.integration.get(nodeId) ?? { nodeId, status: "reviewing" }
    this.integration.set(nodeId, { ...st, status: "integrating", integrationStartedAt: st.integrationStartedAt ?? Date.now() })
    this.metrics.childResultReadyToIntegrateMs = Math.max(0, Date.now() - (st.resultReadyAt ?? Date.now()))
    // Integration overlap: from first integration start to earliest sibling completion.
    const active = Array.from(this.observed.values()).filter((s) => !isTerminalChildState(s.state)).length
    if (active > 0) this.metrics.integrationOverlapMs += 1
  }

  markVerified(nodeId: string): void {
    const st = this.integration.get(nodeId) ?? { nodeId, status: "integrating" }
    this.integration.set(nodeId, { ...st, status: "focused_verification" })
  }

  markIntegrated(nodeId: string): void {
    const st = this.integration.get(nodeId) ?? { nodeId, status: "focused_verification" }
    this.integration.set(nodeId, { ...st, status: "integrated", integratedAt: Date.now() })
    const idx = this.readyQueue.indexOf(nodeId)
    if (idx >= 0) this.readyQueue.splice(idx, 1)
    this.checkConvergence()
  }

  markRejected(nodeId: string): void {
    const st = this.integration.get(nodeId) ?? { nodeId, status: "ready" }
    this.integration.set(nodeId, { ...st, status: "rejected" })
    const idx = this.readyQueue.indexOf(nodeId)
    if (idx >= 0) this.readyQueue.splice(idx, 1)
  }

  /** Child declared a stable API contract (safe to prepare integration against). */
  markContractStable(nodeId: string, contract: { exports?: string[]; ownFiles?: string[]; expectedResultShape?: string[] }): void {
    const st = this.integration.get(nodeId) ?? { nodeId, status: "pending" }
    this.integration.set(nodeId, {
      ...st,
      contract: "stable",
      declaredContract: {
        exports: contract.exports ?? [],
        ownFiles: contract.ownFiles ?? [],
        expectedResultShape: contract.expectedResultShape ?? [],
        sinceMs: Date.now(),
      },
      contractInvalidated: false,
    })
  }

  /** Child changed a declared-stable contract: invalidate prepared integration. */
  markContractChangedAfterStable(nodeId: string): void {
    const st = this.integration.get(nodeId)
    if (!st || st.contract !== "stable") return
    this.integration.set(nodeId, { ...st, contractInvalidated: true, contract: "materializing" })
  }

  /** True once every required child is integrated / failed-and-rerouted / non-required. */
  shouldEnterFinalConvergence(): boolean {
    const desiredIds = Array.from(this.desired.keys())
    if (desiredIds.length === 0) return false
    for (const ws of desiredIds) {
      const st = this.integration.get(ws)?.status
      const observed = this.observed.get(ws)
      if (st === "integrated") continue
      if (st === "rejected") continue
      if (observed && (observed.state === "failed" || observed.state === "cancelled")) continue
      return false
    }
    return true
  }

  enterFinalConvergence(): void {
    this.phase = "final_convergence"
    const active = Array.from(this.observed.values()).filter((s) => !isTerminalChildState(s.state)).length
    this.metrics.awaitAllBarrierMs = active > 0 ? Date.now() : 0
  }

  shouldWaitForAll(): boolean {
    return this.phase === "final_convergence" || this.phase === "complete"
  }

  private checkConvergence(): void {
    if (this.shouldEnterFinalConvergence() && this.phase !== "final_convergence" && this.phase !== "complete") {
      this.phase = "final_convergence"
    }
    const integrated = Array.from(this.desired.keys()).every(
      (ws) => this.integration.get(ws)?.status === "integrated" || this.integration.get(ws)?.status === "rejected",
    )
    if (integrated) {
      this.phase = integrated ? "complete" : this.phase
      if (integrated && this.readyQueue.length === 0) this.phase = "complete"
    }
  }

  ownershipConflicts(): number {
    return this.metrics.ownershipConflicts
  }
  workDuplicationEvents(): number {
    return this.metrics.workDuplicationEvents
  }
  pollModelTurns(): number {
    return this.metrics.pollModelTurns
  }

  metricsSnapshot(): ActiveCoordinatorMetrics {
    return { ...this.metrics }
  }

  /** Compact describe() used by the <200-token Fast Harness parallel packet. */
  describe(): {
    phase: CoordinatorPhase
    desired: Array<{ workstreamId: string; specialist: string }>
    children: Array<{ workstreamId: string; specialist: string; state: string; integration: IntegrationStatus }>
    readyCount: number
    nextDirective: CoordinatorDirective
    coordinatorOwnership: CoordinatorOwnership
  } {
    const children = Array.from(this.desired.keys()).map((ws) => {
      const desired = this.desired.get(ws)!
      const observed = this.observed.get(ws)
      return {
        workstreamId: ws,
        specialist: desired.specialist,
        state: observed ? observed.state : "requested",
        integration: this.integration.get(ws)?.status ?? "pending",
      }
    })
    return {
      phase: this.phase,
      desired: Array.from(this.desired.values()).map((c) => ({ workstreamId: c.workstreamId, specialist: c.specialist })),
      children,
      readyCount: this.getReadyResults().length,
      nextDirective: this.nextCoordinatorDirective(),
      coordinatorOwnership: this.coordinatorOwnership,
    }
  }

  canRootWrite(path: string, handoffScopes: string[] = []): { allowed: boolean; conflict?: string } {
    return canRootWriteImpl(this.ownership, this.coordinatorOwnership, path, handoffScopes)
  }
}

function canRootWriteImpl(
  children: Map<string, ParallelWorkstreamOwnership>,
  coordinator: CoordinatorOwnership,
  path: string,
  handoffScopes: string[],
) {
  const list = Array.from(children.values())
  return canRootWrite(list, coordinator, path, handoffScopes)
}

// ── Module-level registry: one coordinator per parent session/run id ──────
const registry = new Map<string, HeidiActiveCoordinator>()

export function registerParallelCoordinator(sessionID: string, coordinator: HeidiActiveCoordinator): void {
  registry.set(sessionID, coordinator)
}

export function getParallelCoordinator(sessionID: string): HeidiActiveCoordinator | undefined {
  return registry.get(sessionID)
}

export function clearParallelCoordinator(sessionID: string): void {
  registry.delete(sessionID)
}

export function clearAllParallelCoordinators(): void {
  registry.clear()
}
