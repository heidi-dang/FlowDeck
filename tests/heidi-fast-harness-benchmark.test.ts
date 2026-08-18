import { describe, it, expect } from "bun:test"
import { classifyTask } from "../src/services/heidi-fast-router"
import { governanceFastPath } from "../src/services/governance-fast-path"
import { executeBatchReads, type ReadOperation } from "../src/services/read-batch"
import { buildHeidiCoordinatorPrompt } from "../src/agents/orchestrator"
import { liveCorePromptTokens } from "../src/services/heidi-fast-harness-runtime"
import { HeidiPerformanceTracker } from "../src/services/heidi-performance"

const BASELINE_PROMPT_TOKENS = 2933

describe("Heidi Fast Harness — canonical benchmark suite", () => {
  // ── 1. Repository lookup (hot context) ────────────────────────────────
  it("routing latency (user->route) is negligible: << 1ms p50", () => {
    const N = 5000
    const start = performance.now()
    for (let i = 0; i < N; i++) {
      classifyTask("fix a typo in readme")
    }
    const p50 = (performance.now() - start) / N
    expect(p50).toBeLessThan(1)
  })

  it("routing stays fast across realistic task mix (10 canonical tasks)", () => {
    const tasks = [
      ["change the config timeout value", "FAST_DIRECT"],
      ["fix a typo", "FAST_DIRECT"],
      ["debug why this test is failing", "SPECIALIST"],
      ["security audit", "SPECIALIST"],
      ["build a React dashboard UI", "SPECIALIST"],
      ["implement a multi-file feature across several files", "STANDARD"],
      ["architecture migration", "DEEP"],
      ["Build the frontend form and backend API", "PARALLEL_SPECIALISTS"],
      ["Implement the backend order API", "SPECIALIST"],
      ["review the changes in my PR", "SPECIALIST"],
    ] as const
    const start = performance.now()
    for (let i = 0; i < 200; i++) {
      for (const [t, expected] of tasks) {
        const d = classifyTask(t)
        expect(d.executionClass).toBe(expected)
      }
    }
    const avg = (performance.now() - start) / (200 * tasks.length)
    expect(avg).toBeLessThan(1)
  })

  // ── 2. Prompt reduction (one-file config change / one-file fix) ────────
  it("FAST_DIRECT provider context reduction >= 60% (target 70-80%)", () => {
    const lean = buildHeidiCoordinatorPrompt(undefined, "FAST_DIRECT")
    const leanTokens = Math.round(lean.length / 4)
    const reduction = ((BASELINE_PROMPT_TOKENS - leanTokens) / BASELINE_PROMPT_TOKENS) * 100
    expect(reduction).toBeGreaterThanOrEqual(60)
    expect(leanTokens).toBeLessThan(900)
  })

  it("live core prompt (always-on) stays < 900 tokens", () => {
    expect(liveCorePromptTokens()).toBeLessThan(900)
  })

  it("specialist prompt injects directory but FAST_DIRECT does not (context comparison)", () => {
    const spec = buildHeidiCoordinatorPrompt(undefined, "SPECIALIST")
    const lean = buildHeidiCoordinatorPrompt(undefined, "FAST_DIRECT")
    expect(spec).toContain("Available Agents")
    expect(lean).not.toContain("Available Agents")
    expect(spec.length).toBeGreaterThan(lean.length)
  })

  // ── 3. Governance fast path ────────────────────────────────────────────
  it("read-only governance fast path < 5ms p50 (preferred < 2ms)", () => {
    const N = 5000
    const start = performance.now()
    for (let i = 0; i < N; i++) {
      governanceFastPath("fdx-read", "strict", "src/auth.ts")
    }
    const p50 = (performance.now() - start) / N
    expect(p50).toBeLessThan(2)
  })

  it("write/governance full path still engaged for high-risk tools", () => {
    const r = governanceFastPath("bash", "strict")
    expect(r.allowed).toBe(false)
    expect(r.usedFastPath).toBe(false)
  })

  // ── 4. Read batch concurrency (frontend+backend read-heavy) ───────────
  it("read-heavy: 4 independent reads run concurrently (>= 2x speedup target)", async () => {
    const executor = async (_tool: string, _args: Record<string, unknown>) => { await new Promise(r => setTimeout(r, 40)); return "data" }
    const ops: ReadOperation[] = [0, 1, 2, 3].map(i => ({ tool: "fdx-read", args: { file_path: "f" + i + ".ts" }, label: "read-" + i }))
    const seqStart = performance.now()
    for (const _ of ops) await executor("fdx-read", {})
    const sequential = performance.now() - seqStart
    const batchStart = performance.now()
    await executeBatchReads(ops, executor)
    const batch = performance.now() - batchStart
    const speedup = sequential / batch
    expect(speedup).toBeGreaterThanOrEqual(2)
  })

  it("mutation rejected from read batch (writes never parallelized)", async () => {
    const executor = async () => "x"
    await expect(executeBatchReads([{ tool: "bash", args: { command: "rm -rf /" } }], executor)).rejects.toThrow()
  })

  // ── 5. Performance tracing overhead < 1ms p50 ──────────────────────────
  it("tracker span overhead < 1ms p50 for 10k span ops", () => {
    const tracker = new HeidiPerformanceTracker("bench-1")
    const N = 10000
    const start = performance.now()
    for (let i = 0; i < N; i++) {
      const k = tracker.startSpan("tool.before")
      tracker.endSpan(k)
    }
    const p50 = (performance.now() - start) / N
    expect(p50).toBeLessThan(1)
  })

  // ── 6. Long-session state stays compact ───────────────────────────────
  it("task-state packet for a long session stays < 200 tokens", () => {
    const { HeidiTaskState } = require("../src/services/heidi-task-state") as typeof import("../src/services/heidi-task-state")
    const st = new HeidiTaskState("long-1", "long multi-file feature", "STANDARD")
    for (let i = 0; i < 50; i++) st.addVerifiedFact("fact-" + i)
    for (let i = 0; i < 30; i++) st.addChangedFile("file-" + i + ".ts")
    const packet = st.renderContextPacket()
    expect(packet.length).toBeLessThan(800)
  })
})
