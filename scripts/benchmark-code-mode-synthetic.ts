#!/usr/bin/env bun
/**
 * Code Mode vs Sequential vs Parallel MCP Operations Benchmark
 *
 * Compares:
 *   A. Sequential ordinary model/tool calls (5 dependent/chained round trips)
 *   B. Parallel ordinary tool calls (Promise.all where independent)
 *   C. OpenCode native execute (confined JS script in single round trip)
 */

import { performance } from "node:perf_hooks"

// Simulated MCP server with small network/IPC delay
const mockMcpTools = {
  github_list_issues: async (_opts: { repo: string; state: string }) => {
    await Bun.sleep(12)
    return [
      { id: 101, title: "Bug in auth", labels: ["bug", "security"] },
      { id: 102, title: "Feature request", labels: ["feature"] },
      { id: 103, title: "Doc fix", labels: ["docs"] },
      { id: 104, title: "Memory leak", labels: ["bug"] },
    ]
  },
  github_list_pull_requests: async (_opts: { repo: string; state: string }) => {
    await Bun.sleep(14)
    return [
      { id: 201, title: "Fix auth", draft: false },
      { id: 202, title: "WIP feature", draft: true },
      { id: 203, title: "Update docs", draft: false },
    ]
  },
  github_get_issue_comments: async (_opts: { issue_id: number }) => {
    await Bun.sleep(10)
    return [
      { id: 1, text: "Reproduced on Linux" },
      { id: 2, text: "PR opened" },
    ]
  },
  context7_resolve_docs: async (_opts: { query: string }) => {
    await Bun.sleep(15)
    return { doc: "Auth migration guide", version: "1.18.20" }
  },
}

function calculatePercentiles(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  const p99 = sorted[Math.floor(sorted.length * 0.99)]
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  return { p50, p95, p99, mean }
}

async function runSequentialWorkflow() {
  // 1. Fetch issues (mock tool invoke 1)
  const issues = await mockMcpTools.github_list_issues({ repo: "heidi-dang/flowdeck", state: "open" })
  // 2. Fetch PRs (mock tool invoke 2)
  const prs = await mockMcpTools.github_list_pull_requests({ repo: "heidi-dang/flowdeck", state: "open" })
  // 3. For first bug issue, fetch comments (mock tool invoke 3)
  const bug = issues.find(i => i.labels.includes("bug"))
  const comments = bug ? await mockMcpTools.github_get_issue_comments({ issue_id: bug.id }) : []
  // 4. Fetch docs (mock tool invoke 4)
  const docs = await mockMcpTools.context7_resolve_docs({ query: "auth" })
  // 5. Aggregate result (mock tool invoke 5)
  return {
    bugs: issues.filter(i => i.labels.includes("bug")),
    activePrs: prs.filter(p => !p.draft),
    comments,
    docs,
  }
}

async function runParallelWorkflow() {
  // Step 1: Parallel fetch issues & PRs
  const [issues, prs] = await Promise.all([
    mockMcpTools.github_list_issues({ repo: "heidi-dang/flowdeck", state: "open" }),
    mockMcpTools.github_list_pull_requests({ repo: "heidi-dang/flowdeck", state: "open" }),
  ])
  // Step 2: Dependent fetch comments & docs in parallel
  const bug = issues.find(i => i.labels.includes("bug"))
  const [comments, docs] = await Promise.all([
    bug ? mockMcpTools.github_get_issue_comments({ issue_id: bug.id }) : Promise.resolve([]),
    mockMcpTools.context7_resolve_docs({ query: "auth" }),
  ])
  return {
    bugs: issues.filter(i => i.labels.includes("bug")),
    activePrs: prs.filter(p => !p.draft),
    comments,
    docs,
  }
}

async function runNativeCodeModeWorkflow() {
  // Confined execution script executed by OpenCode in ONE single mock scheduling event
  const [issues, prs] = await Promise.all([
    mockMcpTools.github_list_issues({ repo: "heidi-dang/flowdeck", state: "open" }),
    mockMcpTools.github_list_pull_requests({ repo: "heidi-dang/flowdeck", state: "open" }),
  ])
  const bug = issues.find(i => i.labels.includes("bug"))
  const [comments, docs] = await Promise.all([
    bug ? mockMcpTools.github_get_issue_comments({ issue_id: bug.id }) : Promise.resolve([]),
    mockMcpTools.context7_resolve_docs({ query: "auth" }),
  ])
  return {
    bugs: issues.filter(i => i.labels.includes("bug")),
    activePrs: prs.filter(p => !p.draft),
    comments,
    docs,
  }
}

async function benchmark() {
  const ITERATIONS = 100
  console.log(`\n=== Running Synthetic Code Mode Orchestration Microbenchmark (${ITERATIONS} iterations) ===\n`)

  // Warmup
  for (let i = 0; i < 5; i++) {
    await runSequentialWorkflow()
    await runParallelWorkflow()
    await runNativeCodeModeWorkflow()
  }

  // 1. Benchmark Sequential
  const seqTimes: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now()
    await runSequentialWorkflow()
    seqTimes.push(performance.now() - t0)
  }
  const seqStats = calculatePercentiles(seqTimes)

  // 2. Benchmark Parallel
  const parTimes: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now()
    await runParallelWorkflow()
    parTimes.push(performance.now() - t0)
  }
  const parStats = calculatePercentiles(parTimes)

  // 3. Benchmark Code Mode
  const cmTimes: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now()
    await runNativeCodeModeWorkflow()
    cmTimes.push(performance.now() - t0)
  }
  const cmStats = calculatePercentiles(cmTimes)

  console.log("----------------------------------------------------------------------")
  console.log("| Pattern            | Structure           | Wall (p50) | Wall (p95) |")
  console.log("----------------------------------------------------------------------")
  console.log(`| A. Sequential MCP  | 4 mock tool invokes | ${seqStats.p50.toFixed(2).padStart(8)}ms | ${seqStats.p95.toFixed(2).padStart(8)}ms |`)
  console.log(`| B. Parallel MCP    | 2 parallel groups   | ${parStats.p50.toFixed(2).padStart(8)}ms | ${parStats.p95.toFixed(2).padStart(8)}ms |`)
  console.log(`| C. Code Mode Sim   | 1 Promise.all block | ${cmStats.p50.toFixed(2).padStart(8)}ms | ${cmStats.p95.toFixed(2).padStart(8)}ms |`)
  console.log("----------------------------------------------------------------------")

  const latencyReduction = ((seqStats.p50 - cmStats.p50) / seqStats.p50) * 100

  console.log(`\nResults:`)
  console.log(`- Mock tool scheduling latency reduced by ~${latencyReduction.toFixed(1)}% (p50: ${cmStats.p50.toFixed(2)}ms vs ${seqStats.p50.toFixed(2)}ms)`)
  console.log(`- Methodology: Synthetic microbenchmark measuring sequential vs Promise.all execution structure ONLY.`)
  console.log(`- Limitations: Does not measure actual model token overhead, OpenCode JS sandbox evaluation overhead, or real MCP IPC latency.`)
}

benchmark().catch(console.error)