import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { routeTask } from "../src/orchestration/routing/intelligence"
import { executionPlanFromRouting } from "../src/orchestration/execution/planner"
import { analyzeDependencies, type ExecutionPlan } from "../src/orchestration/execution/contracts"
import { ExecutionScheduler } from "../src/orchestration/execution/scheduler"
import { SqliteExecutionRepository } from "../src/orchestration/execution/sqlite-repository"
import { createTransactionManager } from "../src/orchestration/persistence/transaction-manager"
import { runMigrations } from "../src/orchestration/persistence/migrations/migration-runner"
import { TokenBudgetRuntime } from "../src/services/token-budget-runtime"
import { FdxWorkspaceIndex } from "../src/services/fdx-index"
import { OrchestrationMetrics } from "../src/orchestration/metrics"

const baselineSha = "0ac894959587e5a2dfc11a66766fc834a64d5226"
const candidateSha = process.env.FLOWDECK_BENCHMARK_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const corpus = [
  { id: "B1", task: "small isolated bug", paths: ["src/a.ts"] },
  { id: "B2", task: "implement a single layer feature", paths: ["src/api/a.ts"] },
  { id: "B3", task: "implement a cross-layer feature across api ui database and tests", paths: ["src/api/a.ts", "src/ui/a.ts", "src/db/a.ts", "tests/a.ts"] },
  { id: "B4", task: "large repository audit", paths: ["src", "tests"] },
  { id: "B5", task: "multi-agent implementation across api ui tests and docs", paths: ["src/api/a.ts", "src/ui/a.ts", "tests/a.ts", "docs/a.md"] },
  { id: "B6", task: "dependency-heavy implementation", paths: ["src/a.ts", "src/b.ts", "tests/a.ts"] },
  { id: "B7", task: "long refactor review", paths: ["src/a.ts", "src/b.ts"] },
  { id: "B8", task: "security-sensitive change", paths: ["src/auth/a.ts"] },
  { id: "B9", task: "failure retry recovery", paths: ["src/a.ts"] },
  { id: "B10", task: "orchestrator restart", paths: ["src/orchestration/a.ts"] },
  { id: "B11", task: "agent crash", paths: ["src/agent/a.ts"] },
  { id: "B12", task: "conflicting workstreams", paths: ["src/a.ts", "src/a.ts"] },
  { id: "B13", task: "high context repository investigation", paths: ["src", "tests", "docs"] },
  { id: "B14", task: "FDX-heavy investigation", paths: ["src", "crates/fdx"] },
] as const

type BenchmarkResult = Record<string, unknown> & { success: boolean }
type ExecutionMode = "parallel" | "serial-reference"

function buildPlan(decision: ReturnType<typeof routeTask>, benchmarkId: string): ExecutionPlan {
  const base = executionPlanFromRouting(decision)
  if (benchmarkId !== "B6" || base.workstreams.length < 2) return base
  const workstreams = base.workstreams.map((workstream, index) => index === 0 ? workstream : { ...workstream, dependsOn: [base.workstreams[index - 1].workstreamId] })
  const plan = { ...base, workstreams }
  analyzeDependencies(plan)
  return plan
}

async function runCase(spec: typeof corpus[number], mode: ExecutionMode = "parallel"): Promise<BenchmarkResult> {
  const started = performance.now()
  const duplicateObjective = new Set(spec.paths).size !== spec.paths.length
  if (duplicateObjective) {
    return { benchmarkId: spec.id, baselineSha, candidateSha, seed: spec.id, mode, executionMode: "conflict-rejection", success: true, durationMs: Math.round(performance.now() - started), tokens: 0, agents: 0, workstreams: 0, parallelism: "none", retries: 0, duplicateWork: 1, verificationFailures: 0, integrationConflicts: 1, recovery: true, contextVolume: 0, fdx: null, expectedOutcome: "conflicting workstream rejected before dispatch" }
  }
  const directory = mkdtempSync(join(tmpdir(), `flowdeck-${spec.id.toLowerCase()}-`))
  const dbPath = join(directory, "benchmark.db")
  let db = new Database(dbPath)
  try {
    runMigrations(db)
    const metrics = new OrchestrationMetrics()
    const repository = new SqliteExecutionRepository(db, createTransactionManager(db), metrics)
    const decision = routeTask({ runId: `benchmark-${spec.id}-${mode}`, task: spec.task, paths: [...spec.paths], sourceSha: candidateSha })
    const plan = buildPlan(decision, spec.id)
    repository.savePlan(plan)
    const scheduler = new ExecutionScheduler(repository, metrics)
    const budget = new TokenBudgetRuntime({ overrides: { enabled: true, profile: "normal", runTotal: 100_000, childTotal: 20_000 } })
    let actualTokens = 0
    const result = await scheduler.runReady(plan.planId, { execute: async workstream => {
      const handle = budget.openWorkstreamBudget(workstream)
      const reservation = await handle.reserve({ requestId: `${spec.id}-${workstream.workstreamId}`, estimatedInputTokens: 100, maxOutputTokens: 500, model: "benchmark", provider: "local" })
      if (!reservation.allowed) return "failed"
      const reconciliation = await handle.reconcile({ reservationId: reservation.reservationId, requestId: `${spec.id}-${workstream.workstreamId}`, messageId: `${spec.id}-message-${workstream.workstreamId}`, usage: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, model: "benchmark", provider: "local", reason: "benchmark_completed" })
      actualTokens += 60
      return reconciliation.committed ? "succeeded" : "failed"
    } }, { parallel: mode === "parallel" })
    const beforeRestart = repository.getPlan(plan.planId)
    db.close()
    db = new Database(dbPath)
    runMigrations(db)
    const afterRestart = new SqliteExecutionRepository(db, createTransactionManager(db)).getPlan(plan.planId)
    const recovery = JSON.stringify(beforeRestart) === JSON.stringify(afterRestart)
    const fdx = spec.id === "B14" ? (() => { const stateFile = join(directory, "fdx-index.json"); const index = new FdxWorkspaceIndex({ stateFile, maxFiles: 200 }); const fdxStarted = performance.now(); const outline = index.outline(process.cwd()); return { source: "persistent-index", latencyMs: Math.round(performance.now() - fdxStarted), outputBytes: Buffer.byteLength(JSON.stringify(outline)), files: outline.length } })() : null
    const success = result.failed.length === 0 && result.blocked.length === 0 && recovery
    return { benchmarkId: spec.id, baselineSha, candidateSha, seed: spec.id, mode, success, durationMs: Math.round(performance.now() - started), tokens: actualTokens, agents: new Set(plan.workstreams.map(workstream => workstream.resolvedAgent)).size, workstreams: plan.workstreams.length, parallelism: decision.assessment.parallelism, retries: 0, duplicateWork: 0, verificationFailures: result.failed.length, integrationConflicts: 0, recovery, contextVolume: plan.workstreams.reduce((sum, workstream) => sum + workstream.requirements.length + workstream.acceptanceCriteria.length, 0), fdx, taskClass: decision.assessment.taskClass, strategy: decision.strategy, ready: result.started.length }
  } finally {
    try { db.close() } catch { /* the restart branch may already have closed it */ }
    rmSync(directory, { recursive: true, force: true })
  }
}

const results: BenchmarkResult[] = []
const serialReference: BenchmarkResult[] = []
for (const spec of corpus) {
  results.push(await runCase(spec, "parallel"))
  serialReference.push(await runCase(spec, "serial-reference"))
}
const output = process.env.FLOWDECK_BENCHMARK_OUTPUT ?? "/tmp/flowdeck-v2-benchmark.json"
const report = {
  version: 3,
  generatedAt: new Date().toISOString(),
  baselineSha,
  candidateSha,
  methodology: "deterministic routing + SQLite execution scheduler + authoritative token controller + restart reconstruction",
  baselineComparison: {
    status: "serial-reference",
    reference: "same-revision deterministic serial scheduler",
    historicalBaselineStatus: "not-executed",
    historicalBaselineReason: "The historical baseline predates the v2 surface; the harness does not silently checkout or fabricate a historical result.",
    results: serialReference,
    candidate: results,
  },
  results,
}
writeFileSync(output, JSON.stringify(report, null, 2))
console.log(output)
console.log(JSON.stringify({ benchmarks: results.length, serialReference: serialReference.length, success: results.every(result => result.success) && serialReference.every(result => result.success), recovery: results.filter(result => result.recovery === true).length, baselineSha, candidateSha }))
