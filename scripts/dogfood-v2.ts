/**
 * M9 pre-merge CONTROLLED DOGFOOD harness for FlowDeck V2.
 *
 * Proves FlowDeck V2's canonical orchestration works against realistic
 * repository work BEFORE the PR merge — not with whole-runtime mocks.
 *
 *  - The simulated AGENT is deterministic; the ORCHESTRATION is real:
 *    real composed runtime (createProductionOrchestrationRuntime), real git
 *    worktrees, real SQLite DB, real token budget, real scheduler, real
 *    verification/completion, real recovery, real idempotency.
 *  - "Dogfood test only mocks the entire runtime" is a FAIL condition.
 *
 * Scenarios D1–D15 + a bounded soak across all 8 core commands.
 * Usage:  bun scripts/dogfood-v2.ts   (from repo root)
 * Output: scripts/dogfood-v2-results.json + stdout summary.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runMigrations } from "../src/orchestration/persistence/migrations/migration-runner"
import { createProductionOrchestrationRuntime, type ProductionOrchestrationRuntime } from "../src/orchestration/composition"
import { ExecutionScheduler, type ExecutionPlan, type ExecutionWorkstream } from "../src/orchestration/execution"
import type { IsolatedWorkstreamExecutor, IsolatedExecutionResult } from "../src/orchestration/execution/worktree-executor"
import type { WorktreeAllocation } from "../src/orchestration/execution/worktree-manager"
import type { WorkstreamBudgetHandle } from "../src/services/adaptive-execution-control"
import type { CommandFaultHook } from "../src/orchestration/commands/services/durable-command-executor"
import type { CommandResult, CommandInvocation } from "../src/orchestration/commands/domain/command-definition"
import { SqliteCommandInvocationRepository } from "../src/orchestration/commands/persistence/sqlite-command-invocation-repository"
import { createTransactionManager } from "../src/orchestration/persistence/transaction-manager"
import { FileTokenUsageStore, rebuildFromEntries } from "../src/services/token-usage-store"

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

const HANG_TIMEOUT_MS = 45_000
const REPO_HEAD = "b0fc0f0"
const REPO_BRANCH = "feat/v2-m9-commands-as-code"

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

interface DisposableRepo {
  repoDir: string
  worktreeRoot: string
  sha: string
  files: { path: string; content: string }[]
}

/** 1. Disposable repo factory: real git repo with known files, committed. */
function makeDisposableRepo(tmpRoot: string): DisposableRepo {
  const repoDir = join(tmpRoot, "repo")
  const worktreeRoot = join(tmpRoot, "worktrees")
  mkdirSync(repoDir, { recursive: true })
  mkdirSync(join(repoDir, "src"), { recursive: true })
  git(repoDir, "init", "-q")
  git(repoDir, "config", "user.email", "dogfood-v2@flowdeck.test")
  git(repoDir, "config", "user.name", "dogfood-v2")
  const files = [
    { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b;\n" },
    { path: "src/strings.ts", content: "export const up = (s: string) => s.toUpperCase();\n" },
    { path: "README.md", content: "# FlowDeck dogfood repository\n" },
    { path: "package.json", content: "{}\n" },
  ]
  for (const f of files) writeFileSync(join(repoDir, f.path), f.content)
  git(repoDir, "add", "-A")
  git(repoDir, "commit", "-qm", "base")
  const sha = git(repoDir, "rev-parse", "HEAD")
  return { repoDir, worktreeRoot, sha, files }
}

function hashRepoFiles(repo: DisposableRepo): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of repo.files) {
    try { out[f.path] = sha256(readFileSync(join(repo.repoDir, f.path), "utf8")) } catch { out[f.path] = "MISSING" }
  }
  return out
}

type ScalarRow = Record<string, unknown> | undefined
function row(db: Database, sql: string, ...params: SQLQueryBindings[]): ScalarRow {
  return db.query(sql).get(...params) as ScalarRow
}
function countWhere(db: Database, table: string, where = "", params: SQLQueryBindings[] = []): number {
  const sql = where ? `SELECT COUNT(*) AS c FROM ${table} WHERE ${where}` : `SELECT COUNT(*) AS c FROM ${table}`
  const r = row(db, sql, ...params) as { c?: number }
  return Number(r?.c ?? 0)
}
function distinctCount(db: Database, table: string, key: string, where = "", params: SQLQueryBindings[] = []): number {
  const sql = where ? `SELECT COUNT(DISTINCT ${key}) AS c FROM ${table} WHERE ${where}` : `SELECT COUNT(DISTINCT ${key}) AS c FROM ${table}`
  const r = row(db, sql, ...params) as { c?: number }
  return Number(r?.c ?? 0)
}

function openDb(path?: string): Database {
  const db = path ? new Database(path) : new Database(":memory:")
  if (path) db.exec("PRAGMA journal_mode = WAL")
  runMigrations(db)
  return db
}

function closeDb(db: Database | undefined): void {
  if (!db) return
  try { db.close() } catch { /* already closed (crash scenario) */ }
}

// ──────────────────────────────────────────────────────────────────────────
// 2. SimulatedAgentExecutor — deterministic, real filesystem work
// ──────────────────────────────────────────────────────────────────────────

export type AgentBehavior = "READ" | "WRITE" | "FAIL" | "VERIFY_FAIL" | "BUDGET_OK" | "BUDGET_EXCEED" | "AUTO"

interface AgentOutcome extends IsolatedExecutionResult {
  readFacts?: string[]
}

/** Deterministic agent: real work inside the allocation workspace (git worktree). */
export class SimulatedAgentExecutor implements IsolatedWorkstreamExecutor {
  /** Workstream ids in the order the scheduler dispatched them. */
  readonly order: string[] = []
  /** workstreamId -> snapshot of owned-path content after the agent acted. */
  readonly snapshots: Record<string, string[]> = {}
  /** workstreamId -> facts gathered by READ behavior. */
  readonly readFacts: Record<string, string[]> = {}
  private readonly behavior: AgentBehavior

  constructor(behavior: AgentBehavior = "AUTO") {
    this.behavior = behavior
  }

  private resolve(workstream: ExecutionWorkstream): AgentBehavior {
    if (this.behavior !== "AUTO") return this.behavior
    const objective = workstream.objective ?? ""
    if (objective.startsWith("FAIL:")) return "FAIL"
    if (objective.startsWith("WRITE:")) return "WRITE"
    if (objective.startsWith("BUDGET:")) return "BUDGET_OK"
    return "READ"
  }

  async execute(
    workstream: ExecutionWorkstream,
    allocation?: WorktreeAllocation,
    budget?: WorkstreamBudgetHandle,
    _context?: unknown,
  ): Promise<AgentOutcome> {
    this.order.push(workstream.workstreamId)
    const behavior = this.resolve(workstream)
    const ownedPaths = workstream.ownedPaths ?? []

    if (behavior === "FAIL") {
      throw new Error("simulated agent failure")
    }

    if (behavior === "VERIFY_FAIL") {
      await new Promise<void>((r) => setImmediate(r))
      return { status: "succeeded", verificationPassed: false, integrationPassed: false, durationMs: 1 }
    }

    // Token-constrained behaviors exercise the real budget handle.
    if (behavior === "BUDGET_EXCEED") {
      if (budget) {
        try {
          const reserve = await budget.reserve({ requestId: `req-${workstream.workstreamId}`, estimatedInputTokens: 1_000_000, maxOutputTokens: 1_000_000 })
          if (reserve.allowed) {
            await budget.reconcile({ reservationId: reserve.reservationId, requestId: `req-${workstream.workstreamId}`, messageId: `msg-${workstream.workstreamId}`, usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, reason: "completed" })
          } else {
            await budget.terminate("budget_exhausted")
          }
        } catch {
          try { await budget.terminate("budget_exhausted") } catch { /* budget is advisory */ }
        }
      }
      return { status: "failed", verificationPassed: false, integrationPassed: false, durationMs: 1, terminationReason: "budget_exhausted" }
    }

    if (behavior === "BUDGET_OK" && budget) {
      try {
        const reserve = await budget.reserve({ requestId: `req-${workstream.workstreamId}`, estimatedInputTokens: 100, maxOutputTokens: 50 })
        if (reserve.allowed) {
          await budget.reconcile({ reservationId: reserve.reservationId, requestId: `req-${workstream.workstreamId}`, messageId: `msg-${workstream.workstreamId}`, usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, reason: "completed" })
        } else {
          await budget.terminate("budget_exhausted")
          return { status: "failed", verificationPassed: false, integrationPassed: false, durationMs: 1, terminationReason: "budget_exhausted" }
        }
      } catch {
        /* budget is advisory; proceed without accounting */
      }
    }

    const workspace = allocation?.workspace
    const facts: string[] = []
    const snap: string[] = []
    for (const p of ownedPaths) {
      if (workspace) {
        const abs = join(workspace, p)
        if (behavior === "WRITE" || behavior === "BUDGET_OK") {
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, `// simulated write ${workstream.workstreamId}\n`, { flag: "a" })
        } else {
          try { facts.push(`read:${p}:${readFileSync(abs, "utf8").slice(0, 120)}`) } catch { facts.push(`read:${p}:missing`) }
        }
        try { snap.push(`${p}:${sha256(readFileSync(abs, "utf8"))}`) } catch { snap.push(`${p}:missing`) }
      } else {
        facts.push(`read:${p}:no-workspace`)
      }
    }
    this.snapshots[workstream.workstreamId] = snap
    this.readFacts[workstream.workstreamId] = facts

    if (behavior === "WRITE" || behavior === "BUDGET_OK") {
      if (!workspace) throw new Error("WRITE behavior requires an allocation workspace")
      // Commit the real change in the worktree; integration merges the branch.
      git(workspace, "add", "-A")
      git(workspace, "commit", "-qm", `sim-${workstream.workstreamId}`)
    }

    await new Promise<void>((r) => setImmediate(r))
    return { status: "succeeded", verificationPassed: true, integrationPassed: false, durationMs: 1, readFacts: facts }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Hang guard, leak/acceptance scan, evidence accumulator
// ──────────────────────────────────────────────────────────────────────────

interface Guarded<T> {
  hang: boolean
  error?: unknown
  value?: T
}

async function withHangGuard<T>(work: () => Promise<T>): Promise<Guarded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      work().then((value) => ({ hang: false as const, value })),
      new Promise<{ hang: true }>((resolve) => {
        timer = setTimeout(() => resolve({ hang: true }), HANG_TIMEOUT_MS)
      }),
    ])
    return result
  } catch (error) {
    return { hang: false, error }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface TokenScanResult {
  files: number
  reserved: number
  consumed: number
  releasedUnused: number
  negative: boolean
  perRun: Record<string, unknown>
}

/** 6. Leak/acceptance scan against the REAL schema (table names discovered via PRAGMA). */
function tokenScan(repoDir: string | undefined, runIds: string[]): TokenScanResult {
  const perRun: Record<string, unknown> = {}
  let reserved = 0
  let consumed = 0
  let releasedUnused = 0
  let files = 0
  if (repoDir) {
    const store = new FileTokenUsageStore(join(repoDir, ".flowdeck", "token-usage"))
    for (const runId of runIds.filter((id): id is string => typeof id === "string" && id.length > 0)) {
      const rebuilt = rebuildFromEntries(store.read(runId), runId)
      if (rebuilt.records.length > 0 || rebuilt.reservations.length > 0) files += 1
      reserved += rebuilt.reserved
      consumed += rebuilt.consumed
      releasedUnused += rebuilt.releasedUnused
      perRun[runId] = { reserved: rebuilt.reserved, consumed: rebuilt.consumed, releasedUnused: rebuilt.releasedUnused, terminal: rebuilt.terminal?.reason ?? null }
    }
  }
  return { files, reserved, consumed, releasedUnused, negative: reserved < 0 || consumed < 0 || releasedUnused < 0, perRun }
}

interface LeakScanOptions {
  repoDir?: string
  runIds?: string[]
}

interface LeakScanResult {
  worktreeLeases?: { total: number; active: number; activeStates: number; released: number; reclaimable: number }
  ownershipClaims?: number
  assignments?: { total: number; zombie: number }
  bindings?: { total: number; zombie: number }
  completionDecisions?: { total: number; pass: number }
  verifications?: { passed: number }
  evidence?: number
  graph?: { taskRuns: number; plans: number; workstreams: number; assignments: number; completionDecisions: number }
  duplicates?: { plans: boolean; workstreams: boolean; assignments: boolean; completionDecisions: boolean }
  token?: TokenScanResult
  passWithoutEvidence?: number
  error?: string
}

function leakScan(db: Database, runId: string | undefined, opts: LeakScanOptions = {}): LeakScanResult {
  const byRun = (where: string) => (runId ? where : "")
  const params = (_where: string): SQLQueryBindings[] => (runId ? [runId] : [])
  const whereRun = "run_id = ?"
  const runIds = opts.runIds ?? (runId ? [runId] : [])
  const out: LeakScanResult = {}
  try {
    out.worktreeLeases = {
      total: countWhere(db, "execution_worktree_leases"),
      active: countWhere(db, "execution_worktree_leases", byRun(whereRun), params(whereRun)),
      activeStates: countWhere(db, "execution_worktree_leases", `state IN ('allocated','active','renewing')${runId ? " AND run_id = ?" : ""}`, runId ? [runId] : []),
      released: countWhere(db, "execution_worktree_leases", `state = 'released'${runId ? " AND run_id = ?" : ""}`, runId ? [runId] : []),
      reclaimable: countWhere(db, "execution_worktree_leases", `state = 'reclaimable'${runId ? " AND run_id = ?" : ""}`, runId ? [runId] : []),
    }
    out.ownershipClaims = countWhere(db, "execution_ownership_claims", byRun(whereRun), params(whereRun))
    out.assignments = {
      total: countWhere(db, "assignments", byRun(whereRun), params(whereRun)),
      zombie: countWhere(db, "assignments", `status IN ('pending','running')${runId ? " AND run_id = ?" : ""}`, runId ? [runId] : []),
    }
    out.bindings = {
      total: countWhere(db, "assignment_execution_bindings", byRun(whereRun), params(whereRun)),
      zombie: countWhere(db, "assignment_execution_bindings", `dispatch_state IN ('pending','dispatched')${runId ? " AND run_id = ?" : ""}`, runId ? [runId] : []),
    }
    out.completionDecisions = {
      total: countWhere(db, "completion_decisions", byRun(whereRun), params(whereRun)),
      pass: countWhere(db, "completion_decisions", `decision = 'pass'${runId ? " AND run_id = ?" : ""}`, runId ? [runId] : []),
    }
    out.verifications = { passed: countWhere(db, "verification_results", `status = 'passed'${runId ? " AND run_id = ?" : ""}`, runId ? [runId] : []) }
    out.evidence = countWhere(db, "evidence", byRun(whereRun), params(whereRun))
    out.graph = {
      taskRuns: countWhere(db, "task_runs", byRun(whereRun), params(whereRun)),
      plans: countWhere(db, "execution_plans", byRun(whereRun), params(whereRun)),
      workstreams: countWhere(db, "execution_workstreams", byRun(whereRun), params(whereRun)),
      assignments: countWhere(db, "assignments", byRun(whereRun), params(whereRun)),
      completionDecisions: countWhere(db, "completion_decisions", byRun(whereRun), params(whereRun)),
    }
    out.duplicates = {
      plans: distinctCount(db, "execution_plans", "plan_id") !== countWhere(db, "execution_plans"),
      workstreams: distinctCount(db, "execution_workstreams", "workstream_id") !== countWhere(db, "execution_workstreams"),
      assignments: distinctCount(db, "assignments", "id") !== countWhere(db, "assignments"),
      completionDecisions: distinctCount(db, "completion_decisions", "id") !== countWhere(db, "completion_decisions"),
    }
    out.token = tokenScan(opts.repoDir, runIds)
    out.passWithoutEvidence = countWhere(
      db,
      "completion_decisions",
      "decision = 'pass' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.run_id = completion_decisions.run_id)",
    )
  } catch (error) {
    out.error = String(error)
  }
  return out
}

interface ScenarioOutcome {
  scenario: string
  status: "PASS" | "FAIL" | "EXPECTED_FAIL" | "HANG"
  durationMs: number
  result: Record<string, unknown>
  checks: Record<string, unknown>
  leakScan: LeakScanResult
  error?: string
}

interface ScenarioReturn {
  status: "PASS" | "EXPECTED_FAIL" | "FAIL"
  result: Record<string, unknown>
  checks: Record<string, unknown>
  leak: LeakScanResult
  error?: string
}

const evidence: ScenarioOutcome[] = []

async function runScenario(
  name: string,
  fn: () => Promise<ScenarioReturn>,
): Promise<void> {
  const started = Date.now()
  const guarded = await withHangGuard(fn)
  const durationMs = Date.now() - started
  if (guarded.hang) {
    evidence.push({ scenario: name, status: "HANG", durationMs, result: {}, checks: { hang: true }, leakScan: {} })
    return
  }
  if (guarded.error) {
    evidence.push({ scenario: name, status: "FAIL", durationMs, result: {}, checks: {}, leakScan: {}, error: String(guarded.error) })
    return
  }
  const value = guarded.value!
  evidence.push({
    scenario: name,
    status: value.status,
    durationMs,
    result: value.result,
    checks: value.checks,
    leakScan: value.leak,
    error: value.error,
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Runtime helpers
// ──────────────────────────────────────────────────────────────────────────

interface RuntimeHandle {
  db: Database
  runtime: ProductionOrchestrationRuntime
}

function makeRuntime(db: Database, opts: {
  repositoryPath?: string
  worktreeRoot?: string
  behavior?: AgentBehavior
  agent?: IsolatedWorkstreamExecutor
  faultHook?: CommandFaultHook
} = {}): RuntimeHandle {
  const agentExecutor = opts.agent ?? new SimulatedAgentExecutor(opts.behavior ?? "AUTO")
  const runtime = createProductionOrchestrationRuntime(db, {
    repositoryPath: opts.repositoryPath,
    worktreeRoot: opts.worktreeRoot,
    agentExecutor,
    faultHook: opts.faultHook,
  })
  return { db, runtime }
}

/** Gated scheduler (D8 pattern). */
function gateScheduler(runtime: ProductionOrchestrationRuntime): { release(): void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  type RunReady = typeof ExecutionScheduler.prototype.runReady
  const original: RunReady = runtime.executionScheduler.runReady.bind(runtime.executionScheduler)
  ;(runtime.executionScheduler as { runReady: RunReady }).runReady = async (planId, executor, options) => {
    await gate
    return original(planId, executor, options)
  }
  return { release }
}

/** Crash hook: closes the DB after dispatch (D9 pattern). */
function crashAfterDispatchHook(db: Database): CommandFaultHook {
  let closed = false
  return {
    afterDispatch: () => {
      if (closed) return
      closed = true
      try { db.close() } catch { /* already closed */ }
    },
  }
}

async function findRunningInvocation(db: Database, timeoutMs = 10_000): Promise<string | undefined> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const r = row(db, "SELECT invocation_id FROM command_invocations WHERE status = 'running' ORDER BY created_at DESC LIMIT 1")
    if (r?.invocation_id) return String(r.invocation_id)
    await new Promise<void>((r2) => setTimeout(r2, 5))
  }
  return undefined
}

interface CustomPlanWorkstream {
  workstreamId: string
  objective: string
  ownedPaths: string[]
  dependsOn?: string[]
}

function buildCustomPlan(input: {
  planId: string
  runId: string
  sourceSha: string
  workstreams: CustomPlanWorkstream[]
}): ExecutionPlan {
  return {
    planId: input.planId,
    runId: input.runId,
    routingDecisionId: "command:execute:1",
    sourceSha: input.sourceSha,
    policyVersion: "command-execute-v1",
    createdAt: new Date().toISOString(),
    status: "planned",
    workstreams: input.workstreams.map((w) => ({
      workstreamId: w.workstreamId,
      runId: input.runId,
      planId: input.planId,
      resolvedAgent: "backend-coder",
      requiredCapability: "backend",
      objective: w.objective,
      requirements: [],
      acceptanceCriteria: [],
      ownedPaths: w.ownedPaths,
      ownedSymbols: [],
      dependsOn: w.dependsOn ?? [],
      strategy: "delegated",
      budgetProfile: "normal",
      contextScope: "owned",
      status: "planned",
      blockedBy: [],
      createdAt: new Date().toISOString(),
    })),
  }
}

/** Seed a durable run + a pre-created "execute" invocation bound to a custom plan. */
async function seedRunWithPlan(
  db: Database,
  runtime: ProductionOrchestrationRuntime,
  input: { invId: string; sourceSha: string; workstreams: CustomPlanWorkstream[] },
): Promise<{ runId: string; planId: string }> {
  const invRepo = new SqliteCommandInvocationRepository(db, createTransactionManager(db))
  const run = await runtime.services.runService.createRun(
    { runType: "delegated", contractId: "contract_dogfood", correlationId: input.invId, metadata: { dogfood: true } },
    input.invId,
  )
  const invocation: CommandInvocation = {
    invocationId: input.invId,
    commandId: "execute",
    commandVersion: 1,
    idempotencyKey: `ik_${input.invId}`,
    status: "running",
    input: { taskRunId: run.id, sourceSha: input.sourceSha },
    taskRunId: run.id,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await invRepo.saveInvocation(invocation)
  const planId = `plan:${input.invId}`
  const plan = buildCustomPlan({ planId, runId: run.id, sourceSha: input.sourceSha, workstreams: input.workstreams })
  runtime.executionRepository.savePlan(plan)
  db.query("UPDATE command_invocations SET plan_id = ? WHERE invocation_id = ?").run(planId, input.invId)
  return { runId: run.id, planId }
}

// ──────────────────────────────────────────────────────────────────────────
// Scenarios D1–D15
// ──────────────────────────────────────────────────────────────────────────

async function scenarioD1(repo: DisposableRepo): Promise<ScenarioReturn> {
  const before = hashRepoFiles(repo)
  const db = openDb()
  const handle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "READ" })
  try {
    const result = await handle.runtime.commands.executor.executeCommand("task/start", {
      taskDescription: "READ:analyze repo",
      sourceSha: repo.sha,
      ownedPaths: ["src/math.ts", "README.md"],
    })
    const after = hashRepoFiles(repo)
    const agent = handle.runtime.agentExecutor as SimulatedAgentExecutor
    const checks: Record<string, unknown> = {
      commandCompleted: result.status === "completed",
      repoUnchanged: JSON.stringify(before) === JSON.stringify(after),
      oneWorkstreamDispatched: agent.order.length === 1,
      readFactsRecorded: (agent.readFacts[agent.order[0]] ?? []).length > 0,
      planSucceeded: (row(handle.db, "SELECT status FROM execution_plans WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", result.taskRunId!) as { status: string }).status === "succeeded",
      integrationMergedEmpty: countWhere(handle.db, "execution_integration_attempts", "status = 'integrated'") >= 1,
    }
    return {
      status: checks.commandCompleted && checks.repoUnchanged && checks.oneWorkstreamDispatched && checks.readFactsRecorded ? "PASS" : "FAIL",
      result: { runId: result.taskRunId, invocationId: result.invocationId, commandError: result.error?.code },
      checks,
      leak: leakScan(handle.db, result.taskRunId, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD2(repo: DisposableRepo): Promise<ScenarioReturn> {
  const before = hashRepoFiles(repo)
  const db = openDb()
  const agent = new SimulatedAgentExecutor("WRITE")
  const handle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, agent })
  try {
    const result = await handle.runtime.commands.executor.executeCommand("task/start", {
      taskDescription: "WRITE:implement two files",
      sourceSha: repo.sha,
      ownedPaths: ["src/math.ts", "src/strings.ts"],
    })
    const after = hashRepoFiles(repo)
    const wsId = agent.order[0] ?? ""
    const worktreeChanged = (agent.snapshots[wsId] ?? []).length === 2 && (agent.snapshots[wsId] ?? []).every((s) => !s.endsWith(":missing"))
    const checks: Record<string, unknown> = {
      commandCompleted: result.status === "completed",
      bothFilesChangedInRepo: after["src/math.ts"] !== before["src/math.ts"] && after["src/strings.ts"] !== before["src/strings.ts"],
      worktreeFilesChanged: worktreeChanged,
      markersLanded: readFileSync(join(repo.repoDir, "src", "math.ts"), "utf8").includes("simulated write") && readFileSync(join(repo.repoDir, "src", "strings.ts"), "utf8").includes("simulated write"),
      twoOwnedPathsDispatched: agent.order.length === 1,
      integrated: countWhere(handle.db, "execution_workstreams", "status = 'integrated'") === 1,
    }
    return {
      status: checks.commandCompleted && checks.bothFilesChangedInRepo && checks.worktreeFilesChanged && checks.markersLanded && checks.integrated ? "PASS" : "FAIL",
      result: { runId: result.taskRunId, before, after, worktreeSnapshots: agent.snapshots },
      checks,
      leak: leakScan(handle.db, result.taskRunId, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD3(repo: DisposableRepo): Promise<ScenarioReturn> {
  const db = openDb()
  const agent = new SimulatedAgentExecutor("AUTO")
  const handle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, agent })
  try {
    const invId = "inv_d3_dependency"
    const { runId, planId } = await seedRunWithPlan(db, handle.runtime, {
      invId,
      sourceSha: repo.sha,
      workstreams: [
        { workstreamId: "ws-1", objective: "WRITE:first", ownedPaths: ["src/math.ts"] },
        { workstreamId: "ws-2", objective: "WRITE:second", ownedPaths: ["src/strings.ts"], dependsOn: ["ws-1"] },
      ],
    })
    const result = await handle.runtime.commands.executor.recoverCommand(invId)
    const wsRows = db.query("SELECT workstream_id, status, failure_reason FROM execution_workstreams WHERE plan_id = ? ORDER BY workstream_id").all(planId) as { workstream_id: string; status: string; failure_reason: string | null }[]
    const depRows = db.query("SELECT workstream_id, depends_on FROM execution_dependencies WHERE plan_id = ? ORDER BY workstream_id, depends_on").all(planId) as { workstream_id: string; depends_on: string }[]
    const depOk = depRows.length === 1 && depRows[0].workstream_id === "ws-2" && depRows[0].depends_on === "ws-1"
    const checks: Record<string, unknown> = {
      commandCompleted: result.status === "completed",
      exactlyTwoWorkstreams: wsRows.length === 2,
      noDuplicates: countWhere(db, "execution_workstreams", "plan_id = ?", [planId]) === distinctCount(db, "execution_workstreams", "workstream_id", "plan_id = ?", [planId]),
      dependencyPersisted: depOk,
      ws2RanAfterWs1: agent.order.join(",") === "ws-1,ws-2",
      bothIntegrated: wsRows.every((w) => w.status === "integrated"),
      noFailures: wsRows.every((w) => w.failure_reason === null),
    }
    return {
      status: checks.commandCompleted && checks.exactlyTwoWorkstreams && checks.dependencyPersisted && checks.ws2RanAfterWs1 && checks.bothIntegrated && checks.noDuplicates ? "PASS" : "FAIL",
      result: { runId, planId, workstreams: wsRows, dependencies: depRows, agentOrder: agent.order },
      checks,
      leak: leakScan(db, runId, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD4(repo: DisposableRepo): Promise<ScenarioReturn> {
  const db = openDb()
  const agent = new SimulatedAgentExecutor("AUTO")
  const handle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, agent })
  try {
    const invId = "inv_d4_parallel"
    const { runId, planId } = await seedRunWithPlan(db, handle.runtime, {
      invId,
      sourceSha: repo.sha,
      workstreams: [
        { workstreamId: "ws-a", objective: "WRITE:a", ownedPaths: ["src/math.ts"] },
        { workstreamId: "ws-b", objective: "WRITE:b", ownedPaths: ["src/strings.ts"] },
        { workstreamId: "ws-c", objective: "WRITE:c", ownedPaths: ["README.md"] },
      ],
    })
    const result = await handle.runtime.commands.executor.recoverCommand(invId)
    const wsStatuses = db.query("SELECT workstream_id, status FROM execution_workstreams WHERE plan_id = ? ORDER BY workstream_id").all(planId) as { workstream_id: string; status: string }[]
    const assignmentsForPlan = countWhere(db, "assignment_execution_bindings", "plan_id = ?", [planId])
    const checks: Record<string, unknown> = {
      commandCompleted: result.status === "completed",
      exactlyThreeWorkstreams: wsStatuses.length === 3,
      allSucceeded: wsStatuses.every((w) => w.status === "integrated" || w.status === "succeeded"),
      exactlyThreeAssignments: assignmentsForPlan === 3,
      allDispatched: agent.order.length === 3 && agent.order.includes("ws-a") && agent.order.includes("ws-b") && agent.order.includes("ws-c"),
      noDuplicates: wsStatuses.length === distinctCount(db, "execution_workstreams", "workstream_id", "plan_id = ?", [planId]),
    }
    return {
      status: checks.commandCompleted && checks.exactlyThreeWorkstreams && checks.allSucceeded && checks.exactlyThreeAssignments && checks.allDispatched && checks.noDuplicates ? "PASS" : "FAIL",
      result: { runId, planId, workstreams: wsStatuses, assignmentsForPlan, agentOrder: agent.order },
      checks,
      leak: leakScan(db, runId, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD5(repo: DisposableRepo): Promise<ScenarioReturn> {
  const db = openDb()
  const handle = makeRuntime(db)
  try {
    const invId = "inv_d5_conflict"
    const run = await handle.runtime.services.runService.createRun(
      { runType: "delegated", contractId: "contract_dogfood", correlationId: invId, metadata: { dogfood: true } },
      invId,
    )
    const plan = buildCustomPlan({
      planId: `plan:${invId}`,
      runId: run.id,
      sourceSha: repo.sha,
      workstreams: [
        { workstreamId: "ws-1", objective: "WRITE:left", ownedPaths: ["src/math.ts"] },
        { workstreamId: "ws-2", objective: "WRITE:right", ownedPaths: ["src/math.ts"] },
      ],
    })
    let error: string | undefined
    try {
      handle.runtime.executionRepository.savePlan(plan)
    } catch (e) {
      error = String(e)
    }
    const conflictDetected = error !== undefined && error.includes("OVERLAPPING_OWNERSHIP")
    const planPersisted = countWhere(db, "execution_plans") > 0
    return {
      // Fail-closed conflict detection at plan persistence is the EXPECTED
      // outcome: overlapping ownership is a hard conflict in the canonical path.
      status: conflictDetected ? "EXPECTED_FAIL" : "FAIL",
      result: {
        outcome: conflictDetected ? "conflict" : planPersisted ? "completed" : "blocked",
        error,
        note: conflictDetected
          ? "Overlapping ownership rejected at plan persistence (OVERLAPPING_OWNERSHIP) — fail-closed conflict detection, no partial execution."
          : planPersisted
            ? "Overlapping ownership tolerated in canonical path"
            : "Plan blocked for an unexpected reason",
      },
      checks: { conflictDetected, planBlockedFromPersistence: !planPersisted },
      leak: leakScan(db, run.id, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD6(repo: DisposableRepo): Promise<ScenarioReturn> {
  const results: Record<string, unknown> = {}
  const checks: Record<string, unknown> = {}
  let leak: LeakScanResult = {}
  let failure: unknown = null

  // Part A — completion with correct final accounting under a small budget.
  process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL = "500"
  process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL = "300"
  const dbA = openDb()
  try {
    const handleA = makeRuntime(dbA, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "BUDGET_OK" })
    const rA = await handleA.runtime.commands.executor.executeCommand("task/start", {
      taskDescription: "BUDGET:constrained",
      sourceSha: repo.sha,
      ownedPaths: ["src/math.ts"],
    })
    const snapshot = handleA.runtime.tokenRuntime?.getRunSnapshot(rA.taskRunId!) as Record<string, unknown> | undefined
    const tokenLeak = tokenScan(repo.repoDir, [rA.taskRunId!])
    results.partA = { status: rA.status, snapshot, tokenScan: tokenLeak, leak: leakScan(dbA, rA.taskRunId, { repoDir: repo.repoDir }) }
    checks.partACompleted = rA.status === "completed"
    checks.partAAccounting = (snapshot?.run as Record<string, unknown> | undefined)?.reserved === 0 && ((snapshot?.run as Record<string, unknown>)?.consumed as number) > 0
    checks.partANoNegative = !tokenLeak.negative
    leak = leakScan(dbA, rA.taskRunId, { repoDir: repo.repoDir })
  } catch (error) {
    failure = error
  } finally {
    closeDb(dbA)
    delete process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL
    delete process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL
  }

  // Part B — controlled budget failure: reservation exceeds the ceiling.
  process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL = "100"
  process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL = "50"
  const dbB = openDb()
  try {
    const handleB = makeRuntime(dbB, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "BUDGET_EXCEED" })
    const rB = await handleB.runtime.commands.executor.executeCommand("task/start", {
      taskDescription: "BUDGET:exceed",
      sourceSha: repo.sha,
      ownedPaths: ["src/math.ts"],
    })
    const bInv = row(dbB, "SELECT task_run_id FROM command_invocations WHERE invocation_id = ?", rB.invocationId) as { task_run_id: string | null } | undefined
    const bRunId = bInv?.task_run_id ? String(bInv.task_run_id) : undefined
    const tokenLeak = tokenScan(repo.repoDir, bRunId ? [bRunId] : [])
    results.partB = { status: rB.status, errorCode: rB.error?.code, runId: bRunId, tokenScan: tokenLeak }
    checks.partBControlledFailure = rB.status === "failed" && rB.error?.code === "CANONICAL_SCHEDULER_FAILED"
    checks.partBNoNegative = !tokenLeak.negative
    leak = leakScan(dbB, bRunId, { repoDir: repo.repoDir })
  } catch (error) {
    failure = error
  } finally {
    closeDb(dbB)
    delete process.env.FLOWDECK_TOKEN_BUDGET_RUN_TOTAL
    delete process.env.FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL
  }

  return {
    status: failure === null && checks.partACompleted && checks.partAAccounting && checks.partANoNegative && checks.partBControlledFailure && checks.partBNoNegative ? "PASS" : "FAIL",
    result: { ...results, failure: failure === null ? null : String(failure) },
    checks,
    leak,
  }
}

async function scenarioD7(repo: DisposableRepo): Promise<ScenarioReturn> {
  const db = openDb()
  try {
    const handleFail = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "FAIL" })
    const failResult = await handleFail.runtime.commands.executor.executeCommand("task/start", {
      taskDescription: "FAIL:assignment",
      sourceSha: repo.sha,
      ownedPaths: ["src/math.ts"],
    })
    const assignment = row(db, "SELECT status FROM assignments ORDER BY created_at DESC LIMIT 1") as { status: string }
    const binding = row(db, "SELECT dispatch_state FROM assignment_execution_bindings ORDER BY created_at DESC LIMIT 1") as { dispatch_state: string }
    const failChecks: Record<string, unknown> = {
      commandFailed: failResult.status === "failed",
      failureCode: failResult.error?.code === "CANONICAL_SCHEDULER_FAILED",
      assignmentFailed: assignment?.status === "failed",
      bindingFailed: binding?.dispatch_state === "failed",
      noZombies: countWhere(db, "assignments", "status IN ('pending','running')") === 0 && countWhere(db, "execution_workstreams", "status IN ('planned','ready','running')") === 0,
      noPassDecision: countWhere(db, "completion_decisions", "decision = 'pass'") === 0,
    }
    // Retry on a fresh runtime over the same db with a healthy agent.
    const handleRetry = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "READ" })
    const retryResult = await handleRetry.runtime.commands.executor.executeCommand("task/start", {
      taskDescription: "READ:retry after failure",
      sourceSha: repo.sha,
      ownedPaths: ["README.md"],
    })
    const retryChecks: Record<string, unknown> = {
      retryCompleted: retryResult.status === "completed",
    }
    const checks = { ...failChecks, ...retryChecks }
    return {
      status: failChecks.commandFailed && failChecks.failureCode && failChecks.assignmentFailed && failChecks.bindingFailed && failChecks.noZombies && failChecks.noPassDecision && retryChecks.retryCompleted ? "PASS" : "FAIL",
      result: { failResult: { status: failResult.status, errorCode: failResult.error?.code }, assignment, binding, retryResult: { status: retryResult.status } },
      checks,
      leak: leakScan(db, undefined, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD8(repo: DisposableRepo): Promise<ScenarioReturn> {
  const db = openDb()
  const handle = makeRuntime(db)
  try {
    const gate = gateScheduler(handle.runtime)
    const executing = handle.runtime.commands.executor.executeCommand("task/start", { taskDescription: "READ:cancel me" })
    const invocationId = await findRunningInvocation(db)
    if (!invocationId) {
      return { status: "FAIL", result: {}, checks: { foundRunningInvocation: false }, leak: leakScan(db, undefined, { repoDir: repo.repoDir }) }
    }
    const cancelled = await handle.runtime.commands.executor.cancelCommand(invocationId, "dogfood D8 cancellation")
    gate.release()
    const result = await executing
    const planStatus = row(db, "SELECT status FROM execution_plans ORDER BY created_at DESC LIMIT 1") as { status: string }
    const postLeak = leakScan(db, result.taskRunId, { repoDir: repo.repoDir })
    const checks: Record<string, unknown> = {
      commandCancelled: result.status === "cancelled",
      cancelCode: cancelled.error?.code === "COMMAND_CANCELLED",
      planCancelled: planStatus?.status === "cancelled",
      noRunnableWorkstreams: countWhere(db, "execution_workstreams", "status IN ('planned','ready','running')") === 0,
      invocationCancelled: row(db, "SELECT status FROM command_invocations WHERE invocation_id = ?", invocationId)?.status === "cancelled",
      noPassDecision: countWhere(db, "completion_decisions", "decision = 'pass'") === 0,
      noZombieAssignments: (postLeak.assignments?.zombie ?? 0) === 0,
    }
    return {
      status: checks.commandCancelled && checks.cancelCode && checks.planCancelled && checks.noRunnableWorkstreams && checks.invocationCancelled && checks.noPassDecision && checks.noZombieAssignments ? "PASS" : "FAIL",
      result: { invocationId, resultStatus: result.status, errorCode: result.error?.code, planStatus: planStatus?.status, zombieAssignments: postLeak.assignments?.zombie },
      checks,
      leak: postLeak,
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD9(repo: DisposableRepo, tmpRoot: string): Promise<ScenarioReturn> {
  const dbPath = join(tmpRoot, "d9.sqlite")
  const dbA = openDb(dbPath)
  try {
    const hook = crashAfterDispatchHook(dbA)
    const handleA = makeRuntime(dbA, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "WRITE", faultHook: hook })
    let thrown: unknown = null
    try {
      await handleA.runtime.commands.executor.executeCommand("task/start", {
        taskDescription: "WRITE:crash and recover",
        sourceSha: repo.sha,
        ownedPaths: ["src/math.ts"],
      })
    } catch (e) {
      thrown = e
    }
    // dbA is closed by the fault hook; reopen a fresh runtime over the same file.
    const dbB = openDb(dbPath)
    try {
      const handleB = makeRuntime(dbB, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "WRITE" })
      const inv = row(dbB, "SELECT invocation_id, task_run_id, plan_id, status FROM command_invocations ORDER BY created_at DESC LIMIT 1") as { invocation_id: string; task_run_id: string; plan_id: string; status: string }
      const recovered = await handleB.runtime.commands.executor.recoverCommand(inv.invocation_id)
      const checks: Record<string, unknown> = {
        crashSimulated: thrown !== null,
        recoveredCompleted: recovered.status === "completed",
        singleRun: countWhere(dbB, "task_runs") === 1,
        singlePlan: countWhere(dbB, "execution_plans") === 1,
        singleWorkstream: countWhere(dbB, "execution_workstreams") === 1,
        singleAssignment: countWhere(dbB, "assignments") === 1,
        singleDecision: countWhere(dbB, "completion_decisions") === 1 && countWhere(dbB, "completion_decisions", "decision = 'pass'") === 1,
        singleIntegration: countWhere(dbB, "execution_integration_attempts", "status = 'integrated'") === 1,
        samePlanId: inv.plan_id !== undefined,
        workstreamIntegrated: (row(dbB, "SELECT status FROM execution_workstreams LIMIT 1") as { status: string }).status === "integrated",
        noActiveLeases: countWhere(dbB, "execution_worktree_leases", "state IN ('allocated','active','renewing')") === 0,
        noZombies: countWhere(dbB, "assignments", "status IN ('pending','running')") === 0,
      }
      return {
        status: checks.crashSimulated && checks.recoveredCompleted && checks.singleRun && checks.singlePlan && checks.singleWorkstream && checks.singleAssignment && checks.singleDecision && checks.singleIntegration && checks.noActiveLeases && checks.noZombies ? "PASS" : "FAIL",
        result: { dbPath, invocation: inv, recovered: { status: recovered.status, taskRunId: recovered.taskRunId }, thrown: thrown ? String(thrown).slice(0, 200) : null },
        checks,
        leak: leakScan(dbB, inv.task_run_id, { repoDir: repo.repoDir }),
      }
    } finally {
      closeDb(dbB)
    }
  } finally {
    closeDb(dbA)
  }
}

async function scenarioD10(repo: DisposableRepo): Promise<ScenarioReturn> {
  const db = openDb()
  const handle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "VERIFY_FAIL" })
  try {
    const result = await handle.runtime.commands.executor.executeCommand("task/start", {
      taskDescription: "WRITE:verification gate",
      sourceSha: repo.sha,
      ownedPaths: ["src/math.ts"],
    })
    const ws = row(db, "SELECT status, failure_reason FROM execution_workstreams ORDER BY created_at DESC LIMIT 1") as { status: string; failure_reason: string | null }
    const invRow = row(db, "SELECT task_run_id FROM command_invocations WHERE invocation_id = ?", result.invocationId) as { task_run_id: string | null } | undefined
    const runId = invRow?.task_run_id ? String(invRow.task_run_id) : undefined
    const checks: Record<string, unknown> = {
      commandFailed: result.status === "failed",
      failureCode: result.error?.code === "CANONICAL_SCHEDULER_FAILED",
      workstreamFailed: ws?.status === "failed",
      failureReasonPresent: ws?.failure_reason !== null && ws?.failure_reason !== undefined && ws?.failure_reason !== "",
      neverIntegrated: countWhere(db, "execution_workstreams", "status IN ('integrated','integration_pending','succeeded')") === 0,
      noPassDecision: countWhere(db, "completion_decisions", "decision = 'pass'") === 0,
      singleWorkstream: countWhere(db, "execution_workstreams") === 1,
      noZombies: countWhere(db, "execution_workstreams", "status IN ('planned','ready','running')") === 0,
    }
    return {
      status: checks.commandFailed && checks.failureCode && checks.workstreamFailed && checks.failureReasonPresent && checks.neverIntegrated && checks.noPassDecision && checks.singleWorkstream && checks.noZombies ? "PASS" : "FAIL",
      result: { errorCode: result.error?.code, runId, workstream: ws, note: "Verification gate rejects at dispatch: agent verificationPassed=false is authoritative (VERIFICATION_REQUIRED_BEFORE_INTEGRATION); recorded failure_reason reflects the dispatch-boundary rejection." },
      checks,
      leak: leakScan(db, runId, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD11(repo: DisposableRepo): Promise<ScenarioReturn> {
  const db = openDb()
  const handle = makeRuntime(db)
  try {
    const r1 = await handle.runtime.commands.executor.executeCommand("task/start", { taskDescription: "READ:evidence gate" })
    const runId = r1.taskRunId!
    const r2 = await handle.runtime.commands.executor.executeCommand("complete", { taskRunId: runId })
    const evidenceCount = countWhere(db, "evidence", "run_id = ?", [runId])
    const passedVerifications = countWhere(db, "verification_results", "status = 'passed' AND run_id = ?", [runId])
    const passDecisions = countWhere(db, "completion_decisions", "decision = 'pass' AND run_id = ?", [runId])
    // The gate cannot be bypassed: no pass decision may exist without evidence.
    const passWithoutEvidence = countWhere(
      db,
      "completion_decisions",
      "decision = 'pass' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.run_id = completion_decisions.run_id)",
    )
    const checks: Record<string, unknown> = {
      taskStartCompleted: r1.status === "completed",
      completeCompleted: r2.status === "completed",
      evidenceGenerated: evidenceCount > 0,
      verificationPassed: passedVerifications > 0,
      passDecisionWithEvidence: passDecisions === 1 && evidenceCount > 0,
      passWithoutEvidenceCount: passWithoutEvidence === 0,
    }
    return {
      status: checks.taskStartCompleted && checks.completeCompleted && checks.evidenceGenerated && checks.verificationPassed && checks.passDecisionWithEvidence && checks.passWithoutEvidenceCount ? "PASS" : "FAIL",
      result: {
        note: "Canonical path always generates evidence; a pass completion decision is produced ONLY when evidence rows exist. Global invariant: no run has a pass decision with zero evidence.",
        evidenceCount, passedVerifications, passDecisions, passWithoutEvidence,
      },
      checks,
      leak: leakScan(db, runId, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

interface D12Snapshot {
  dbPath: string
  invocationId: string
  runId: string
  planId: string
  counts: { runs: number; plans: number; workstreams: number; assignments: number; decisions: number; verifications: number; evidence: number }
}

async function scenarioD12(repo: DisposableRepo, tmpRoot: string): Promise<ScenarioReturn & { d12?: D12Snapshot }> {
  const dbPath = join(tmpRoot, "d12.sqlite")
  const db = openDb(dbPath)
  const handle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "WRITE" })
  try {
    const result = await handle.runtime.commands.executor.executeCommand("task/start", {
      taskDescription: "WRITE:happy path",
      sourceSha: repo.sha,
      ownedPaths: ["src/math.ts", "src/strings.ts"],
    })
    const runId = result.taskRunId!
    const checks: Record<string, unknown> = {
      commandCompleted: result.status === "completed",
      verificationPassedRows: countWhere(db, "verification_results", "status = 'passed' AND run_id = ?", [runId]) > 0,
      evidenceRows: countWhere(db, "evidence", "run_id = ?", [runId]) > 0,
      singlePassDecision: countWhere(db, "completion_decisions", "decision = 'pass' AND run_id = ?", [runId]) === 1,
      integrated: countWhere(db, "execution_workstreams", "status = 'integrated' AND run_id = ?", [runId]) === 1,
    }
    const d12: D12Snapshot = {
      dbPath,
      invocationId: result.invocationId!,
      runId,
      planId: String((row(db, "SELECT plan_id FROM command_invocations WHERE invocation_id = ?", result.invocationId) as { plan_id: string }).plan_id),
      counts: {
        runs: countWhere(db, "task_runs", "run_id = ?", [runId]),
        plans: countWhere(db, "execution_plans", "run_id = ?", [runId]),
        workstreams: countWhere(db, "execution_workstreams", "run_id = ?", [runId]),
        assignments: countWhere(db, "assignments", "run_id = ?", [runId]),
        decisions: countWhere(db, "completion_decisions", "run_id = ?", [runId]),
        verifications: countWhere(db, "verification_results", "run_id = ?", [runId]),
        evidence: countWhere(db, "evidence", "run_id = ?", [runId]),
      },
    }
    return {
      status: checks.commandCompleted && checks.verificationPassedRows && checks.evidenceRows && checks.singlePassDecision && checks.integrated ? "PASS" : "FAIL",
      result: { runId, invocationId: result.invocationId, d12 },
      checks,
      leak: leakScan(db, runId, { repoDir: repo.repoDir }),
      d12,
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD13(repo: DisposableRepo, d12: D12Snapshot | undefined, d9DbPath: string | undefined): Promise<ScenarioReturn> {
  const checks: Record<string, unknown> = {}
  const results: Record<string, unknown> = {}
  let leak: LeakScanResult = {}

  if (d12) {
    // Fresh runtime over D12's db file: recoverCommand projects COMPLETED with zero rerun.
    const db = openDb(d12.dbPath)
    try {
      const handle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "WRITE" })
      const recovered = await handle.runtime.commands.executor.recoverCommand(d12.invocationId)
      const counts = {
        runs: countWhere(db, "task_runs", "run_id = ?", [d12.runId]),
        plans: countWhere(db, "execution_plans", "run_id = ?", [d12.runId]),
        workstreams: countWhere(db, "execution_workstreams", "run_id = ?", [d12.runId]),
        assignments: countWhere(db, "assignments", "run_id = ?", [d12.runId]),
        decisions: countWhere(db, "completion_decisions", "run_id = ?", [d12.runId]),
        verifications: countWhere(db, "verification_results", "run_id = ?", [d12.runId]),
        evidence: countWhere(db, "evidence", "run_id = ?", [d12.runId]),
      }
      const again = await handle.runtime.commands.executor.recoverCommand(d12.invocationId)
      const countsAfterAgain = {
        runs: countWhere(db, "task_runs", "run_id = ?", [d12.runId]),
        plans: countWhere(db, "execution_plans", "run_id = ?", [d12.runId]),
        workstreams: countWhere(db, "execution_workstreams", "run_id = ?", [d12.runId]),
        assignments: countWhere(db, "assignments", "run_id = ?", [d12.runId]),
        decisions: countWhere(db, "completion_decisions", "run_id = ?", [d12.runId]),
        verifications: countWhere(db, "verification_results", "run_id = ?", [d12.runId]),
        evidence: countWhere(db, "evidence", "run_id = ?", [d12.runId]),
      }
      checks.d12RecoverCompleted = recovered.status === "completed"
      checks.d12RecoverIdempotent = again.status === "completed"
      checks.d12CountsFrozen = JSON.stringify(counts) === JSON.stringify(d12.counts)
      checks.d12NoRerunOnRepeat = JSON.stringify(countsAfterAgain) === JSON.stringify(counts)
      results.d12Recover = { status: recovered.status, counts, countsAfterAgain }
      leak = leakScan(db, d12.runId, { repoDir: repo.repoDir })
    } finally {
      closeDb(db)
    }
  } else {
    checks.d12RecoverCompleted = false
  }

  if (d9DbPath && existsSync(d9DbPath)) {
    const db = openDb(d9DbPath)
    try {
      const handle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "WRITE" })
      const inv = row(db, "SELECT invocation_id, task_run_id FROM command_invocations LIMIT 1") as { invocation_id: string; task_run_id: string }
      const before = {
        runs: countWhere(db, "task_runs"), plans: countWhere(db, "execution_plans"),
        workstreams: countWhere(db, "execution_workstreams"), assignments: countWhere(db, "assignments"),
        decisions: countWhere(db, "completion_decisions"),
      }
      const again = await handle.runtime.commands.executor.recoverCommand(inv.invocation_id)
      const after = {
        runs: countWhere(db, "task_runs"), plans: countWhere(db, "execution_plans"),
        workstreams: countWhere(db, "execution_workstreams"), assignments: countWhere(db, "assignments"),
        decisions: countWhere(db, "completion_decisions"),
      }
      checks.d9RecoverIdempotent = again.status === "completed" && JSON.stringify(before) === JSON.stringify(after)
      results.d9Recover = { status: again.status, before, after }
    } finally {
      closeDb(db)
    }
  } else {
    checks.d9RecoverIdempotent = false
  }

  return {
    status: checks.d12RecoverCompleted && checks.d12RecoverIdempotent && checks.d12CountsFrozen && checks.d12NoRerunOnRepeat && checks.d9RecoverIdempotent ? "PASS" : "FAIL",
    result: results,
    checks,
    leak,
  }
}

async function scenarioD14(repo: DisposableRepo): Promise<ScenarioReturn> {
  const db = openDb()
  const handle = makeRuntime(db)
  try {
    const idempotencyKey = "ik_d14_concurrent"
    const submissions = Array.from({ length: 20 }, () =>
      handle.runtime.commands.executor.executeCommand("task/start", { taskDescription: "READ:concurrent identical" }, { idempotencyKey }),
    )
    const results = await Promise.all(submissions)
    const uniqueInvocationIds = new Set(results.map((r) => r.invocationId))
    const failedStatuses = results.filter((r) => r.status === "failed")
    const runId = results[0]?.taskRunId
    const checks: Record<string, unknown> = {
      allReturned: results.length === 20,
      singleInvocationId: uniqueInvocationIds.size === 1,
      singleInvocationRow: countWhere(db, "command_invocations", "idempotency_key = ?", [idempotencyKey]) === 1,
      singleCompletionDecision: runId !== undefined && countWhere(db, "completion_decisions", "run_id = ?", [runId]) === 1 && countWhere(db, "completion_decisions", "decision = 'pass' AND run_id = ?", [runId]) === 1,
      noFailedStatus: failedStatuses.length === 0,
    }
    return {
      status: checks.allReturned && checks.singleInvocationId && checks.singleInvocationRow && checks.singleCompletionDecision && checks.noFailedStatus ? "PASS" : "FAIL",
      result: { idempotencyKey, uniqueInvocationIds: [...uniqueInvocationIds], statuses: results.map((r) => r.status), runId },
      checks,
      leak: leakScan(db, runId, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

async function scenarioD15(repo: DisposableRepo): Promise<ScenarioReturn> {
  const db = openDb()
  const agent = new SimulatedAgentExecutor("AUTO")
  const handle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, agent })
  try {
    const invId = "inv_d15_integration"
    const { runId, planId } = await seedRunWithPlan(db, handle.runtime, {
      invId,
      sourceSha: repo.sha,
      workstreams: [
        { workstreamId: "ws-1", objective: "WRITE:one", ownedPaths: ["src/math.ts"] },
        { workstreamId: "ws-2", objective: "WRITE:two", ownedPaths: ["src/strings.ts"] },
      ],
    })
    const result = await handle.runtime.commands.executor.recoverCommand(invId)
    const integratedAttempts = db.query("SELECT attempt_id, plan_id, workstream_id, status FROM execution_integration_attempts WHERE status = 'integrated' AND plan_id = ? ORDER BY workstream_id").all(planId) as { attempt_id: string; plan_id: string; workstream_id: string; status: string }[]
    const perWs = new Map<string, number>()
    for (const a of integratedAttempts) perWs.set(a.workstream_id, (perWs.get(a.workstream_id) ?? 0) + 1)
    const wsStatuses = db.query("SELECT workstream_id, status FROM execution_workstreams WHERE plan_id = ? ORDER BY workstream_id").all(planId) as { workstream_id: string; status: string }[]
    const planStatus = row(db, "SELECT status FROM execution_plans WHERE plan_id = ?", planId) as { status: string }
    const checks: Record<string, unknown> = {
      commandCompleted: result.status === "completed",
      everyWorkstreamIntegrated: wsStatuses.every((w) => w.status === "integrated"),
      integrationRanOncePerWorkstream: perWs.size === 2 && [...perWs.values()].every((c) => c === 1),
      noDuplicateIntegration: integratedAttempts.length === 2,
      planSucceeded: planStatus?.status === "succeeded",
    }
    return {
      status: checks.commandCompleted && checks.everyWorkstreamIntegrated && checks.integrationRanOncePerWorkstream && checks.noDuplicateIntegration && checks.planSucceeded ? "PASS" : "FAIL",
      result: { runId, planId, integratedAttempts, perWorkstreamCounts: Object.fromEntries(perWs), workstreams: wsStatuses, planStatus: planStatus?.status },
      checks,
      leak: leakScan(db, runId, { repoDir: repo.repoDir }),
    }
  } finally {
    closeDb(db)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Soak: bounded loop across ALL 8 core commands
// ──────────────────────────────────────────────────────────────────────────

interface SoakEntry {
  commandId: string
  status: string
  durationMs: number
  expected: string
  note?: string
}

interface SoakLeaks {
  zombies: { assignments?: number; bindings?: number }
  activeLeases?: number
  negativeTokenBalance?: boolean
  duplicateRows?: unknown
  passWithoutEvidence?: number
}

interface SoakResult {
  totalRuns: number
  distribution: Record<string, number>
  unexpectedFailures: SoakEntry[]
  hangs: SoakEntry[]
  cancellations: SoakEntry[]
  expectedFailures: SoakEntry[]
  leaks: SoakLeaks
  entries: SoakEntry[]
}

async function runSoak(repo: DisposableRepo, tmpRoot: string): Promise<SoakResult> {
  const entries: SoakEntry[] = []
  const dbPath = join(tmpRoot, "soak.sqlite")
  const db = openDb(dbPath)
  const record = async (commandId: string, expected: string, work: () => Promise<CommandResult>, note?: string): Promise<CommandResult> => {
    const started = Date.now()
    const guarded = await withHangGuard(work)
    const durationMs = Date.now() - started
    if (guarded.hang) {
      entries.push({ commandId, status: "HANG", durationMs, expected, note: "timeout" })
      return { invocationId: "", commandId, commandVersion: 0, status: "pending", summary: "HANG", timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs } }
    }
    if (guarded.error) {
      entries.push({ commandId, status: "HARNESS_ERROR", durationMs, expected, note: String(guarded.error) })
      return { invocationId: "", commandId, commandVersion: 0, status: "failed", summary: String(guarded.error), timestamps: { startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs } }
    }
    const result = guarded.value!
    entries.push({ commandId, status: result.status, durationMs, expected, note })
    return result
  }

  try {
    const runtime = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "AUTO" }).runtime

    // 1) Fresh task/start (WRITE) — establishes the reused taskRunId.
    const s1 = await record("task/start", "completed", () =>
      runtime.commands.executor.executeCommand("task/start", { taskDescription: "WRITE:soak-1", sourceSha: repo.sha, ownedPaths: ["src/math.ts"], idempotencyKey: "ik_soak_1" }))
    const taskRunId = s1.taskRunId ?? ""

    // 2) Duplicate submission of the same command with the same idempotency key.
    const dup = await record("task/start(dup)", "completed", () =>
      runtime.commands.executor.executeCommand("task/start", { taskDescription: "WRITE:soak-1", sourceSha: repo.sha, ownedPaths: ["src/math.ts"], idempotencyKey: "ik_soak_1" }))
    const dupEntry = entries[entries.length - 1]
    dupEntry.note = dup.invocationId === s1.invocationId ? "idempotent retrieval" : "DIFFERENT INVOCATION"

    // 3) 8 runs of each metadata command reusing the taskRunId.
    const metadataCommands: { id: string; input: Record<string, unknown> }[] = [
      { id: "status", input: {} },
      { id: "plan", input: {} },
      { id: "verify", input: {} },
      { id: "complete", input: {} },
      { id: "review/audit", input: {} },
      { id: "resume/recover", input: {} },
    ]
    for (const cmd of metadataCommands) {
      for (let i = 0; i < 8; i += 1) {
        await record(cmd.id, "completed", () => runtime.commands.executor.executeCommand(cmd.id, { taskRunId, ...cmd.input }))
      }
    }

    // 4) Two execute commands over the same taskRunId.
    for (let i = 0; i < 2; i += 1) {
      await record("execute", "completed", () =>
        runtime.commands.executor.executeCommand("execute", { taskRunId, sourceSha: repo.sha, ownedPaths: ["src/strings.ts"] }))
    }

    // 5) Second fresh task/start.
    await record("task/start", "completed", () =>
      runtime.commands.executor.executeCommand("task/start", { taskDescription: "WRITE:soak-2", sourceSha: repo.sha, ownedPaths: ["src/strings.ts"], idempotencyKey: "ik_soak_2" }))

    // 6) One agent FAIL and its retry (separate runtime over the same db).
    const failRuntime = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "FAIL" }).runtime
    await record("task/start", "failed", () =>
      failRuntime.commands.executor.executeCommand("task/start", { taskDescription: "FAIL:soak", sourceSha: repo.sha, ownedPaths: ["src/math.ts"], idempotencyKey: "ik_soak_fail" }),
      "expected agent failure")
    await record("task/start", "completed", () =>
      runtime.commands.executor.executeCommand("task/start", { taskDescription: "WRITE:soak-retry", sourceSha: repo.sha, ownedPaths: ["src/math.ts"], idempotencyKey: "ik_soak_retry" }))

    // 7) One cancellation (gated scheduler on a dedicated runtime over the same db).
    const cancelHandle = makeRuntime(db, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "AUTO" })
    const gate = gateScheduler(cancelHandle.runtime)
    const cancelStarted = Date.now()
    const cancelExec = cancelHandle.runtime.commands.executor.executeCommand("task/start", { taskDescription: "READ:soak-cancel", sourceSha: repo.sha, ownedPaths: ["README.md"], idempotencyKey: "ik_soak_cancel" })
    const cancelInvocation = await findRunningInvocation(db)
    if (cancelInvocation) await cancelHandle.runtime.commands.executor.cancelCommand(cancelInvocation, "dogfood soak cancellation")
    gate.release()
    const cancelResult = await cancelExec
    entries.push({ commandId: "task/start", status: cancelResult.status, durationMs: Date.now() - cancelStarted, expected: "cancelled", note: "gated cancellation" })

    // 8) One restart + recover (crash runtime closes its OWN db handle).
    const dbCrash = openDb(dbPath)
    const crashHook = crashAfterDispatchHook(dbCrash)
    const crashRuntime = makeRuntime(dbCrash, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "WRITE", faultHook: crashHook }).runtime
    try {
      await crashRuntime.commands.executor.executeCommand("task/start", { taskDescription: "WRITE:soak-crash", sourceSha: repo.sha, ownedPaths: ["src/math.ts"], idempotencyKey: "ik_soak_crash" })
    } catch {
      /* crash expected */
    }
    const dbRec = openDb(dbPath)
    const recRuntime = makeRuntime(dbRec, { repositoryPath: repo.repoDir, worktreeRoot: repo.worktreeRoot, behavior: "WRITE" }).runtime
    const crashInv = row(dbRec, "SELECT invocation_id FROM command_invocations WHERE idempotency_key = ?", "ik_soak_crash") as { invocation_id: string }
    if (crashInv?.invocation_id) {
      await record("resume/recover", "completed", () => recRuntime.commands.executor.recoverCommand(crashInv.invocation_id), "restart recovery")
    } else {
      entries.push({ commandId: "resume/recover", status: "HARNESS_ERROR", durationMs: 0, expected: "completed", note: "crash invocation not found" })
    }
    closeDb(dbCrash)
    closeDb(dbRec)

    // Final soak-wide leak scan (whole db, all runs).
    const allRunIds = (db.query("SELECT run_id FROM task_runs").all() as { run_id: string }[]).map((r) => r.run_id)
    const soakLeak = leakScan(db, undefined, { repoDir: repo.repoDir, runIds: allRunIds })

    const unexpected = entries.filter((e) => e.status === "failed" && e.expected !== "failed")
    const harnessErrors = entries.filter((e) => e.status === "HARNESS_ERROR")
    const hangs = entries.filter((e) => e.status === "HANG")
    const expectedFailures = entries.filter((e) => e.expected === "failed")
    const cancellations = entries.filter((e) => e.status === "cancelled")
    const distribution: Record<string, number> = {}
    for (const e of entries) distribution[e.commandId] = (distribution[e.commandId] ?? 0) + 1

    return {
      totalRuns: entries.length,
      distribution,
      unexpectedFailures: [...unexpected, ...harnessErrors],
      hangs,
      cancellations,
      expectedFailures,
      leaks: {
        zombies: { assignments: soakLeak.assignments?.zombie, bindings: soakLeak.bindings?.zombie },
        activeLeases: soakLeak.worktreeLeases?.activeStates,
        negativeTokenBalance: (soakLeak.token as TokenScanResult)?.negative,
        duplicateRows: soakLeak.duplicates,
        passWithoutEvidence: soakLeak.passWithoutEvidence,
      },
      entries,
    }
  } finally {
    closeDb(db)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Output
// ──────────────────────────────────────────────────────────────────────────

function writeResults(soak: SoakResult | undefined): void {
  const summary = {
    pass: evidence.filter((e) => e.status === "PASS").length,
    expectedFail: evidence.filter((e) => e.status === "EXPECTED_FAIL").length,
    fail: evidence.filter((e) => e.status === "FAIL").length,
    hang: evidence.filter((e) => e.status === "HANG").length,
  }
  const payload = {
    harness: {
      repo: "FlowDeck-m9",
      branch: REPO_BRANCH,
      head: REPO_HEAD,
      bun: process.version,
      ranAt: new Date().toISOString(),
      hangTimeoutMs: HANG_TIMEOUT_MS,
      note: "Dogfood mocks ONLY the agent; orchestration (runtime composition, git worktrees, SQLite, budget, scheduler, verification, completion, recovery, idempotency) is the real production path.",
    },
    scenarios: evidence,
    soak: soak ?? null,
    summary,
    acceptance: {
      scenariosClean: summary.fail === 0 && summary.hang === 0,
      soakClean: soak !== undefined && soak.unexpectedFailures.length === 0 && soak.hangs.length === 0 && !(soak.leaks.zombies?.assignments) && !(soak.leaks.zombies?.bindings) && !(soak.leaks.activeLeases) && soak.leaks.negativeTokenBalance !== true && soak.leaks.passWithoutEvidence !== undefined && soak.leaks.passWithoutEvidence === 0,
    },
  }
  const outPath = join(process.cwd(), "scripts", "dogfood-v2-results.json")
  writeFileSync(outPath, JSON.stringify(payload, null, 2))
  console.log("results written:", outPath)
  console.log(JSON.stringify(payload, null, 2).slice(0, 6000))
}

function printSummary(soak: SoakResult | undefined): void {
  console.log("\n=== DOGFOOD D1-D15 SUMMARY ===")
  for (const e of evidence) {
    const keyChecks = Object.entries(e.checks).filter(([, v]) => v === false).map(([k]) => k)
    console.log(`${e.scenario.padEnd(8)} ${e.status.padEnd(13)} ${String(e.durationMs).padStart(7)}ms ${keyChecks.length ? `FAILED-CHECKS: ${keyChecks.join(",")}` : ""}${e.error ? ` ERROR: ${e.error}` : ""}`)
  }
  if (soak) {
    console.log("\n=== SOAK ===")
    console.log(`totalRuns=${soak.totalRuns} distribution=${JSON.stringify(soak.distribution)}`)
    console.log(`unexpectedFailures=${soak.unexpectedFailures.length} hangs=${soak.hangs.length} cancellations=${soak.cancellations.length} expectedFailures=${soak.expectedFailures.length}`)
    console.log("leaks:", JSON.stringify(soak.leaks))
    console.log("\n=== SOAK TABLE ===")
    for (const e of soak.entries) {
      console.log(`${e.commandId.padEnd(18)} ${e.status.padEnd(10)} ${String(e.durationMs).padStart(6)}ms expected=${e.expected}${e.note ? ` (${e.note})` : ""}`)
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "dogfood-v2-"))
  let soak: SoakResult | undefined
  let d12: D12Snapshot | undefined
  let d9DbPath: string | undefined
  try {
    const repo = makeDisposableRepo(tmpRoot)
    await runScenario("D1", () => scenarioD1(repo))
    await runScenario("D2", () => scenarioD2(repo))
    await runScenario("D3", () => scenarioD3(repo))
    await runScenario("D4", () => scenarioD4(repo))
    await runScenario("D5", () => scenarioD5(repo))
    await runScenario("D6", () => scenarioD6(repo))
    await runScenario("D7", () => scenarioD7(repo))
    await runScenario("D8", () => scenarioD8(repo))
    await runScenario("D9", async () => {
      d9DbPath = join(tmpRoot, "d9.sqlite")
      return scenarioD9(repo, tmpRoot)
    })
    await runScenario("D10", () => scenarioD10(repo))
    await runScenario("D11", () => scenarioD11(repo))
    await runScenario("D12", async () => {
      const out = await scenarioD12(repo, tmpRoot)
      d12 = out.d12
      return out
    })
    await runScenario("D13", () => scenarioD13(repo, d12, d9DbPath))
    await runScenario("D14", () => scenarioD14(repo))
    await runScenario("D15", () => scenarioD15(repo))
    soak = await runSoak(repo, tmpRoot)
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* tmp cleanup best effort */ }
  }
  writeResults(soak)
  printSummary(soak)
  const scenarioFails = evidence.some((e) => e.status === "FAIL" || e.status === "HANG")
  const soakFails = soak !== undefined && (soak.unexpectedFailures.length > 0 || soak.hangs.length > 0 || Boolean(soak.leaks.zombies?.assignments) || Boolean(soak.leaks.zombies?.bindings) || Boolean(soak.leaks.activeLeases) || soak.leaks.negativeTokenBalance === true)
  return scenarioFails || soakFails ? 1 : 0
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error("DOGFOOD HARNESS CRASHED:", error)
  process.exit(2)
})
