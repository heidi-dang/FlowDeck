import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { validateV2Milestones } from "./verify-v2-milestones.mjs"
import { validateBenchmarkReport } from "./verify-v2-benchmark.mjs"

const root = new URL("../", import.meta.url)
const read = file => fs.readFileSync(new URL(file, root), "utf8")
const required = [
  "src/orchestration/execution/sqlite-repository.ts",
  "src/orchestration/execution/scheduler.ts",
  "src/orchestration/execution/worktree-executor.ts",
  "src/services/adaptive-execution-control.ts",
  "src/orchestration/performance/sqlite-repository.ts",
  "src/orchestration/routing/authoritative.ts",
  "src/services/fdx-daemon.ts",
  "src/services/fdx-index.ts",
  "scripts/benchmark-v2.ts",
  "scripts/verify-v2-milestones.mjs",
  "tests/v2-hardening.test.ts",
]
for (const file of required) if (!fs.existsSync(new URL(file, root))) throw new Error(`GATEKEEPER_MISSING_FILE:${file}`)
for (const file of ["src/orchestration/execution/worktree-manager.ts", "src/services/fdx-daemon.ts"]) {
  if (/shell\s*:\s*true/.test(read(file))) throw new Error(`GATEKEEPER_UNSAFE_SHELL:${file}`)
}
const matrix = JSON.parse(read("docs/v2/milestone-completion.json"))
const summary = validateV2Milestones(matrix)
if (summary.completion !== 100 || summary.partial !== 0 || summary.open !== 0) throw new Error("GATEKEEPER_MILESTONE_MATRIX_NOT_TERMINAL")
const benchmarkFile = process.env.FLOWDECK_BENCHMARK_OUTPUT ?? "/tmp/flowdeck-v2-benchmark.json"
if (!fs.existsSync(benchmarkFile)) throw new Error("GATEKEEPER_BENCHMARK_MISSING")
const benchmark = validateBenchmarkReport(JSON.parse(fs.readFileSync(benchmarkFile, "utf8")))
if (!benchmark.candidateSuccess || !benchmark.referenceSuccess) throw new Error("GATEKEEPER_BENCHMARK_FAILURE")
const packageJson = JSON.parse(read("package.json"))
if (!/^2\.0\.0-(alpha|rc)\.[1-9][0-9]*$/.test(packageJson.version)) throw new Error("GATEKEEPER_PACKAGE_VERSION_INVALID")
const masterPlan = execFileSync(process.execPath, [new URL("scripts/verify-completion-matrix.mjs", root).pathname], { encoding: "utf8" })
if (!/100%/.test(masterPlan) || !/0\s+open/i.test(masterPlan) || !/0\s+partial/i.test(masterPlan)) throw new Error("GATEKEEPER_MASTER_PLAN_NOT_TERMINAL")
console.log(JSON.stringify({ milestoneCompletion: summary, benchmark, packageVersion: packageJson.version, masterPlan: "100% / OPEN=0 / PARTIAL=0", findings: [] }))
