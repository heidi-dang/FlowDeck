import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"

export type DelegationNodeAccess = "read" | "write"
export type DelegationNodeComplexity = "small" | "normal" | "large"
export type DelegationNodeStatus =
  | "queued"
  | "reserved"
  | "dispatching"
  | "running"
  | "completed"
  | "failed"
  | "cancel_pending"
  | "cancelled"
  | "blocked"

export interface DelegationNode {
  id: string
  runId: string
  specialist: string
  goal: string
  dependencies: string[]
  access: DelegationNodeAccess
  fileScopes?: string[]
  priority: number
  estimatedComplexity: DelegationNodeComplexity
  status: DelegationNodeStatus
  childSessionId?: string
  attempt: number
  createdAt: number
  startedAt?: number
  completedAt?: number
  summary?: string
  error?: string
  result?: ChildResult
  integrationStatus?: IntegrationStatus
  resultReadyAt?: number
  reviewStartedAt?: number
  integrationStartedAt?: number
  integratedAt?: number
}

export interface DelegationRun {
  runId: string
  parentSessionId: string
  goal: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  createdAt: string
  startedAt?: string
  finishedAt?: string
  nodes: DelegationNode[]
}

export type IntegrationStatus =
  | "pending"
  | "ready"
  | "reviewing"
  | "integrating"
  | "focused_verification"
  | "integrated"
  | "rejected"

export interface ParallelIntegrationState {
  nodeId: string
  status: IntegrationStatus
  resultReadyAt?: number
  reviewStartedAt?: number
  integrationStartedAt?: number
  integratedAt?: number
}

export interface ChildSnapshotView {
  nodeId: string
  workstreamId: string
  specialist: string
  status: DelegationNodeStatus
  integrationStatus: IntegrationStatus
  access: DelegationNodeAccess
  fileScopes: string[]
  startedAt?: number
  completedAt?: number
}

export interface ChildResult {
  delegationId: string
  status: "completed" | "failed" | "cancelled"
  summary: string
  verifiedFacts: string[]
  changedFiles: string[]
  artifacts: string[]
  tests: {
    command: string
    status: "pass" | "fail" | "not_run"
  }[]
  blockers: string[]
  confidence?: number
}

export interface ParallelExecutionConfig {
  enabled: boolean
  maxChildren: number
  defaultTarget: number
  maxWriteChildren: number
  childTimeoutMs: number
  retryLimit: number
  adaptive: boolean
}

export const DEFAULT_PARALLEL_CONFIG: ParallelExecutionConfig = {
  enabled: true,
  maxChildren: 6,
  defaultTarget: 4,
  maxWriteChildren: 3,
  childTimeoutMs: 600000,
  retryLimit: 1,
  adaptive: true,
}

export class HeidiParallelEngine {
  constructor(
    private readonly db: Database,
    private readonly config: ParallelExecutionConfig = DEFAULT_PARALLEL_CONFIG
  ) {}

  /**
   * Create a new DelegationRun with nodes in SQLite.
   * Validates DAG (no cycles, valid dependency refs, no duplicates).
   */
  createRun(input: {
    parentSessionId: string
    goal: string
    nodes: Array<{
      id?: string
      specialist: string
      goal: string
      dependencies?: string[]
      access?: DelegationNodeAccess
      fileScopes?: string[]
      priority?: number
      estimatedComplexity?: DelegationNodeComplexity
    }>
  }): DelegationRun {
    const runId = `run_${randomUUID().slice(0, 8)}`
    const nowIso = new Date().toISOString()
    const nowMs = Date.now()

    // 1. Normalize nodes
    const nodeMap = new Map<string, DelegationNode>()
    const rawNodes = input.nodes

    // Duplicate detection deterministically
    const seenKeys = new Set<string>()
    const normalizedNodes: DelegationNode[] = []

    for (let i = 0; i < rawNodes.length; i++) {
      const raw = rawNodes[i]
      const nodeId = raw.id ?? `node_${i + 1}_${randomUUID().slice(0, 4)}`
      const deps = raw.dependencies ?? []
      const spec = raw.specialist
      const access = raw.access ?? "read"
      const scopes = (raw.fileScopes ?? []).sort()
      const goalStr = raw.goal.trim()

      const dupKey = `${spec}:${goalStr}:${deps.sort().join(",")}:${scopes.join(",")}`
      if (seenKeys.has(dupKey)) {
        // Skip exact duplicate node
        continue
      }
      seenKeys.add(dupKey)

      const node: DelegationNode = {
        id: nodeId,
        runId,
        specialist: spec,
        goal: goalStr,
        dependencies: deps,
        access,
        fileScopes: scopes,
        priority: raw.priority ?? 0,
        estimatedComplexity: raw.estimatedComplexity ?? "normal",
        status: "queued",
        attempt: 0,
        createdAt: nowMs,
      }
      nodeMap.set(nodeId, node)
      normalizedNodes.push(node)
    }

    // 2. Validate dependencies & cycles
    const allIds = new Set(nodeMap.keys())
    for (const node of normalizedNodes) {
      for (const dep of node.dependencies) {
        if (!allIds.has(dep)) {
          throw new Error(`INVALID_DAG_DEPENDENCY: Node ${node.id} references missing dependency ${dep}`)
        }
      }
    }

    // Topological cycle check (Kahn's algorithm)
    const inDegree = new Map<string, number>()
    const adj = new Map<string, string[]>()
    for (const id of allIds) {
      inDegree.set(id, 0)
      adj.set(id, [])
    }
    for (const node of normalizedNodes) {
      for (const dep of node.dependencies) {
        adj.get(dep)!.push(node.id)
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1)
      }
    }

    const queue: string[] = []
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id)
    }
    let visitedCount = 0
    while (queue.length > 0) {
      const curr = queue.shift()!
      visitedCount++
      for (const neighbor of adj.get(curr) ?? []) {
        inDegree.set(neighbor, inDegree.get(neighbor)! - 1)
        if (inDegree.get(neighbor) === 0) queue.push(neighbor)
      }
    }
    if (visitedCount !== normalizedNodes.length) {
      throw new Error("INVALID_DAG_CYCLE: Circular dependency detected in delegation graph")
    }

    // 3. Persist run & nodes inside SQLite transaction
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.query(
        "INSERT INTO heidi_delegation_runs (run_id, parent_session_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(runId, input.parentSessionId, input.goal, "queued", nowIso)

      for (const node of normalizedNodes) {
        this.db.query(
          `INSERT INTO heidi_delegation_nodes (
            id, run_id, specialist, goal, dependencies, access, file_scopes, priority,
            estimated_complexity, status, attempt, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          node.id,
          node.runId,
          node.specialist,
          node.goal,
          JSON.stringify(node.dependencies),
          node.access,
          JSON.stringify(node.fileScopes ?? []),
          node.priority,
          node.estimatedComplexity,
          node.status,
          node.attempt,
          node.createdAt
        )
      }
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }

    return {
      runId,
      parentSessionId: input.parentSessionId,
      goal: input.goal,
      status: "queued",
      createdAt: nowIso,
      nodes: normalizedNodes,
    }
  }

  /**
   * Get a DelegationRun by ID with its nodes.
   */
  getRun(runId: string): DelegationRun | null {
    const row = this.db.query("SELECT * FROM heidi_delegation_runs WHERE run_id = ?").get(runId) as any
    if (!row) return null

    const nodeRows = this.db.query(
      "SELECT * FROM heidi_delegation_nodes WHERE run_id = ? ORDER BY priority DESC, created_at ASC"
    ).all(runId) as any[]

    const nodes: DelegationNode[] = nodeRows.map(r => ({
      id: r.id,
      runId: r.run_id,
      specialist: r.specialist,
      goal: r.goal,
      dependencies: JSON.parse(r.dependencies || "[]"),
      access: r.access,
      fileScopes: JSON.parse(r.file_scopes || "[]"),
      priority: r.priority,
      estimatedComplexity: r.estimated_complexity,
      status: r.status,
      childSessionId: r.child_session_id ?? undefined,
      attempt: r.attempt,
      createdAt: r.created_at,
      startedAt: r.started_at ?? undefined,
      completedAt: r.completed_at ?? undefined,
      summary: r.summary ?? undefined,
      error: r.error ?? undefined,
      result: r.result_json ? JSON.parse(r.result_json) : undefined,
    }))

    return {
      runId: row.run_id,
      parentSessionId: row.parent_session_id,
      goal: row.goal,
      status: row.status,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      nodes,
    }
  }

  /**
   * Find all dispatchable/runnable nodes in a run.
   * A node is runnable iff:
   *  - status is 'queued'
   *  - all dependencies in run are 'completed'
   *  - write scopes do not conflict with currently running write nodes
   */
  findRunnableNodes(
    runId: string,
    options?: {
      tokenBudgetCapacity?: number
      providerCapacity?: number
      configuredHardLimit?: number
    }
  ): DelegationNode[] {
    const run = this.getRun(runId)
    if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return []
    }

    const nodeMap = new Map(run.nodes.map(n => [n.id, n]))
    const runningNodes = run.nodes.filter(n => n.status === "running" || n.status === "dispatching" || n.status === "reserved")
    const activeWriteScopes = runningNodes
      .filter(n => n.access === "write")
      .flatMap(n => n.fileScopes ?? [])

    // Effective concurrency calculation
    const hardLimit = options?.configuredHardLimit ?? this.config.maxChildren
    const tokenCap = options?.tokenBudgetCapacity ?? this.config.maxChildren
    const provCap = options?.providerCapacity ?? this.config.maxChildren
    const maxWrite = this.config.maxWriteChildren

    const effectiveConcurrency = Math.min(hardLimit, tokenCap, provCap)
    const availableSlots = Math.max(0, effectiveConcurrency - runningNodes.length)
    if (availableSlots <= 0) return []

    const runningWriteCount = runningNodes.filter(n => n.access === "write").length

    const candidateNodes: DelegationNode[] = []
    let selectedCandidateWriteCount = 0

    // Sort queued nodes first by priority/critical path before filtering to ensure highest priority gets write slot
    const dependentCounts = new Map<string, number>()
    for (const n of run.nodes) dependentCounts.set(n.id, 0)
    for (const n of run.nodes) {
      for (const d of n.dependencies) {
        dependentCounts.set(d, (dependentCounts.get(d) ?? 0) + 1)
      }
    }

    const queuedNodes = run.nodes.filter(n => n.status === "queued").sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      const bDeps = dependentCounts.get(b.id) ?? 0
      const aDeps = dependentCounts.get(a.id) ?? 0
      if (bDeps !== aDeps) return bDeps - aDeps
      return a.createdAt - b.createdAt
    })

    for (const node of queuedNodes) {
      // Check all dependencies complete
      let depsComplete = true
      for (const depId of node.dependencies) {
        const depNode = nodeMap.get(depId)
        if (!depNode || depNode.status !== "completed") {
          depsComplete = false
          break
        }
      }
      if (!depsComplete) continue

      // Check write slot & scope conflict
      if (node.access === "write") {
        if (runningWriteCount + selectedCandidateWriteCount >= maxWrite) {
          continue
        }
        // Scope conflict check with active running write nodes AND previously selected candidate write nodes
        const nodeScopes = node.fileScopes ?? []
        const activeAndCandidateWriteScopes = [
          ...activeWriteScopes,
          ...candidateNodes.filter(c => c.access === "write").flatMap(c => c.fileScopes ?? [])
        ]
        const hasScopeConflict = nodeScopes.some(s =>
          activeAndCandidateWriteScopes.some(active => active === s || s.startsWith(active) || active.startsWith(s))
        )
        if (hasScopeConflict) continue

        selectedCandidateWriteCount++
      }

      candidateNodes.push(node)
    }

    return candidateNodes.slice(0, availableSlots)
  }

  /**
   * Transition a node state atomically.
   */
  transitionNode(
    nodeId: string,
    status: DelegationNodeStatus,
    detail?: {
      childSessionId?: string
      summary?: string
      error?: string
      result?: ChildResult
    }
  ): void {
    const nowMs = Date.now()
    const nowIso = new Date().toISOString()

    this.db.exec("BEGIN IMMEDIATE")
    try {
      const row = this.db.query("SELECT run_id, status FROM heidi_delegation_nodes WHERE id = ?").get(nodeId) as any
      if (!row) {
        this.db.exec("ROLLBACK")
        throw new Error(`NODE_NOT_FOUND:${nodeId}`)
      }
      const runId = row.run_id

      this.db.query(
        `UPDATE heidi_delegation_nodes SET
          status = ?,
          child_session_id = COALESCE(?, child_session_id),
          started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
          completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END,
          summary = COALESCE(?, summary),
          error = COALESCE(?, error),
          result_json = COALESCE(?, result_json)
        WHERE id = ?`
      ).run(
        status,
        detail?.childSessionId ?? null,
        status,
        nowMs,
        status,
        nowMs,
        detail?.summary ?? null,
        detail?.error ?? null,
        detail?.result ? JSON.stringify(detail.result) : null,
        nodeId
      )

      // Also sync legacy heidi_delegation_activity table for /fd-agents backward compatibility
      if (detail?.childSessionId) {
        this.db.query(
          `INSERT INTO heidi_delegation_activity (
            child_id, parent_session_id, specialist, goal, state, created_at, started_at, finished_at, summary, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(child_id) DO UPDATE SET
            state = excluded.state,
            finished_at = excluded.finished_at,
            summary = COALESCE(excluded.summary, summary),
            error = COALESCE(excluded.error, error)`
        ).run(
          nodeId,
          runId,
          "specialist",
          "goal",
          status === "completed" ? "completed" : status === "failed" ? "failed" : "running",
          nowIso,
          nowIso,
          ["completed", "failed", "cancelled"].includes(status) ? nowIso : null,
          detail?.summary ?? null,
          detail?.error ?? null
        )
      }

      // Check run status updates
      const allNodes = this.db.query("SELECT id, status, dependencies FROM heidi_delegation_nodes WHERE run_id = ?").all(runId) as any[]

      // Check if any blocked nodes exist
      for (const n of allNodes) {
        if (n.status === "queued") {
          const deps: string[] = JSON.parse(n.dependencies || "[]")
          const failedDep = allNodes.some(other => deps.includes(other.id) && ["failed", "cancelled", "blocked"].includes(other.status))
          if (failedDep) {
            this.db.query("UPDATE heidi_delegation_nodes SET status = 'blocked' WHERE run_id = ? AND id = ?").run(runId, n.id)
          }
        }
      }

      const updatedNodes = this.db.query("SELECT status FROM heidi_delegation_nodes WHERE run_id = ?").all(runId) as any[]
      const isTerminal = updatedNodes.every(n => ["completed", "failed", "cancelled", "blocked"].includes(n.status))
      if (isTerminal) {
        const hasFailed = updatedNodes.some(n => n.status === "failed" || n.status === "blocked")
        const runStatus = hasFailed ? "failed" : "completed"
        this.db.query("UPDATE heidi_delegation_runs SET status = ?, finished_at = ? WHERE run_id = ?").run(runStatus, nowIso, runId)
      } else {
        this.db.query("UPDATE heidi_delegation_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE run_id = ?").run(nowIso, runId)
      }

      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  /**
   * Reconcile & recover unfinished runs after process restart.
   */
  recoverOnRestart(): { recoveredRuns: number; resumedNodes: string[]; orphanedNodes: string[] } {
    const unfinishedRuns = this.db.query(
      "SELECT run_id FROM heidi_delegation_runs WHERE status IN ('queued', 'running')"
    ).all() as any[]

    const resumedNodes: string[] = []
    const orphanedNodes: string[] = []

    for (const r of unfinishedRuns) {
      const run = this.getRun(r.run_id)
      if (!run) continue

      for (const node of run.nodes) {
        if (node.status === "running" || node.status === "dispatching" || node.status === "reserved") {
          if (node.access === "write") {
            // Write nodes in unknown state are marked 'blocked' to avoid replaying duplicate writes blindly
            this.transitionNode(node.id, "blocked", {
              error: "RESTART_RECOVERY: Unknown write state after process restart — flagged for review",
            })
            orphanedNodes.push(node.id)
          } else {
            // Read nodes can safely be re-queued
            this.transitionNode(node.id, "queued")
            resumedNodes.push(node.id)
          }
        }
      }
    }

    return {
      recoveredRuns: unfinishedRuns.length,
      resumedNodes,
      orphanedNodes,
    }
  }
  // ── Active-Parallel integration lifecycle (kept OUT of execution status) ──
  // execution status = completed does NOT mean the root has consumed the result.
  private integrationRegistry = new Map<string, ParallelIntegrationState>()

  setIntegrationStatus(
    nodeId: string,
    status: IntegrationStatus,
    opts?: { resultReadyAt?: number; reviewStartedAt?: number; integrationStartedAt?: number }
  ): ParallelIntegrationState {
    const now = Date.now()
    const prev = this.integrationRegistry.get(nodeId) ?? { nodeId, status: "pending" }
    const next: ParallelIntegrationState = {
      nodeId,
      status,
      resultReadyAt: prev.resultReadyAt ?? opts?.resultReadyAt ?? (status === "ready" ? now : prev.resultReadyAt),
      reviewStartedAt: prev.reviewStartedAt ?? opts?.reviewStartedAt ?? (status === "reviewing" ? now : prev.reviewStartedAt),
      integrationStartedAt: prev.integrationStartedAt ?? opts?.integrationStartedAt ?? (status === "integrating" ? now : prev.integrationStartedAt),
      integratedAt: status === "integrated" ? now : prev.integratedAt,
    }
    this.integrationRegistry.set(nodeId, next)
    return next
  }

  getIntegrationStatus(nodeId: string): ParallelIntegrationState | undefined {
    return this.integrationRegistry.get(nodeId)
  }

  /**
   * Deterministic READY queue ordering:
   * 1. blocking/critical-path (dependent count), 2. explicit priority,
   * 3. dependency-unblocking, 4. completion timestamp, 5. stable id tie-break.
   */
  readyResults(runId: string): DelegationNode[] {
    const run = this.getRun(runId)
    if (!run) return []
    const completed = run.nodes.filter((n) => n.status === "completed")
    const ready = completed.filter((n) => {
      const integration = this.integrationRegistry.get(n.id)
      const st = integration?.status ?? (n.integrationStatus ?? "ready")
      return st === "pending" || st === "ready"
    })
    const dependentCounts = new Map<string, number>()
    for (const n of run.nodes) dependentCounts.set(n.id, 0)
    for (const n of run.nodes) for (const d of n.dependencies) dependentCounts.set(d, (dependentCounts.get(d) ?? 0) + 1)
    return ready.sort((a, b) => {
      const aDeps = dependentCounts.get(a.id) ?? 0
      const bDeps = dependentCounts.get(b.id) ?? 0
      if (bDeps !== aDeps) return bDeps - aDeps
      if (b.priority !== a.priority) return b.priority - a.priority
      const at = a.completedAt ?? a.createdAt
      const bt = b.completedAt ?? b.createdAt
      if (at !== bt) return at - bt
      return a.id.localeCompare(b.id)
    })
  }

  /** Minimal child-view for the coordinator: no transcripts, no hidden reasoning. */
  childrenSnapshot(runId: string): ChildSnapshotView[] {
    const run = this.getRun(runId)
    if (!run) return []
    return run.nodes.map((n) => ({
      nodeId: n.id,
      workstreamId: n.id,
      specialist: n.specialist,
      status: n.status,
      integrationStatus: this.integrationRegistry.get(n.id)?.status ?? n.integrationStatus ?? "pending",
      access: n.access,
      fileScopes: n.fileScopes ?? [],
      startedAt: n.startedAt,
      completedAt: n.completedAt,
    }))
  }

}
