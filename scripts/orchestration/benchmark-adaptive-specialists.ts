import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { classifyTask } from "../../src/services/heidi-fast-router"
import { buildSpecialistPlan } from "../../src/orchestration/routing/specialist-planner"

const ITERATIONS = Number(process.env.FLOWDECK_ADAPTIVE_BENCH_ITERATIONS ?? 500)
const WARMUP_ITERATIONS = 50
const ROUTING_P95_BUDGET_MS = 5
const SPECIALIST_SETUP_P95_BUDGET_MS = 10
const outputPath = process.env.FLOWDECK_ADAPTIVE_BENCHMARK_OUTPUT ?? "/tmp/flowdeck-adaptive-specialist-benchmark.json"
const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()

if (!Number.isInteger(ITERATIONS) || ITERATIONS < 50) {
  throw new Error("FLOWDECK_ADAPTIVE_BENCH_ITERATIONS must be an integer of at least 50")
}

interface LatencyStats {
  count: number
  averageMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

function stats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (percent: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent) - 1)]
  return {
    count: samples.length,
    averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? 0,
  }
}

function measure(operation: (iteration: number) => void): LatencyStats {
  for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) operation(iteration)
  const samples: number[] = []
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const started = performance.now()
    operation(iteration)
    samples.push(performance.now() - started)
  }
  return stats(samples)
}

const directPrompt = "Tell me what PostgreSQL version package.json expects."
const singlePrompt = "Delegate this security audit to a specialist."
const multiPrompt = "Fix auth race across API DB UI."

const directRouting = measure(() => {
  const decision = classifyTask(directPrompt)
  if (decision.executionMode !== "DIRECT") throw new Error("BENCHMARK_DIRECT_MODE_REGRESSION")
})

const singleSpecialistSetup = measure(iteration => {
  const decision = classifyTask(singlePrompt)
  const plan = buildSpecialistPlan({ runId: `single-${iteration}`, goal: singlePrompt, decision })
  if (plan.executionMode !== "SINGLE_SPECIALIST" || plan.specs.length !== 1) throw new Error("BENCHMARK_SINGLE_PLAN_REGRESSION")
})

const multiSpecialistSetup = measure(iteration => {
  const decision = classifyTask(multiPrompt)
  const plan = buildSpecialistPlan({ runId: `multi-${iteration}`, goal: multiPrompt, decision })
  if (plan.executionMode !== "MULTI_SPECIALIST" || plan.specs.length < 2) throw new Error("BENCHMARK_MULTI_PLAN_REGRESSION")
})

const budgets = {
  directRoutingP95Ms: ROUTING_P95_BUDGET_MS,
  singleSpecialistSetupP95Ms: SPECIALIST_SETUP_P95_BUDGET_MS,
  multiSpecialistSetupP95Ms: SPECIALIST_SETUP_P95_BUDGET_MS,
}
const pass =
  directRouting.p95Ms <= budgets.directRoutingP95Ms &&
  singleSpecialistSetup.p95Ms <= budgets.singleSpecialistSetupP95Ms &&
  multiSpecialistSetup.p95Ms <= budgets.multiSpecialistSetupP95Ms

const report = {
  version: 1,
  candidateSha,
  generatedAt: new Date().toISOString(),
  iterations: ITERATIONS,
  warmupIterations: WARMUP_ITERATIONS,
  methodology: "In-process deterministic classifier and SpecialistSpec planner microbenchmark after warm-up; excludes OpenCode network/model latency and measures only FlowDeck orchestration overhead.",
  budgets,
  results: {
    directRouting,
    singleSpecialistSetup,
    multiSpecialistSetup,
  },
  pass,
}

writeFileSync(outputPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
if (!pass) process.exitCode = 1
