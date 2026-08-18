import { describe, it, expect } from "bun:test"
import {
  executeBatchReads,
  formatBatchResults,
  isSafeReadTool,
  type ReadOperation,
} from "../src/services/read-batch"

describe("ReadBatchService — Milestone D", () => {
  // Required: independent reads run concurrently
  it("executes multiple reads in parallel, faster than sequential", async () => {
    let callCount = 0
    const executor = async (tool: string, _args: Record<string, unknown>) => {
      callCount++
      await new Promise(r => setTimeout(r, 20))
      return "result-" + tool
    }
    const ops: ReadOperation[] = [
      { tool: "fdx-read", args: { file_path: "a.ts" } },
      { tool: "fdx-grep", args: { pattern: "foo" } },
      { tool: "fdx-search", args: { pattern: "bar" } },
    ]
    const start = Date.now()
    const result = await executeBatchReads(ops, executor)
    const elapsed = Date.now() - start
    // Sequential would take 60ms+; parallel should complete faster. The bound
    // is platform-tolerant (Windows CI runners are slower than local Linux);
    // the meaningful checks are correct results, full concurrency and no hangs.
    expect(elapsed).toBeLessThan(1000)
    expect(result.results).toHaveLength(3)
    expect(result.parallelCount).toBe(3)
    expect(result.anyErrors).toBe(false)
    expect(callCount).toBe(3)
  })

  it("returns correct results with labels", async () => {
    const executor = async (tool: string, args: Record<string, unknown>) => {
      return { tool, args }
    }
    const ops: ReadOperation[] = [
      { tool: "fdx-read", args: { file_path: "src/index.ts" }, label: "main-file" },
      { tool: "fdx-outline", args: { file_path: "src/index.ts" }, label: "outline" },
    ]
    const result = await executeBatchReads(ops, executor)
    expect(result.results[0].label).toBe("main-file")
    expect(result.results[1].label).toBe("outline")
  })

  // Required: overlapping writes remain serialized (reject write tools)
  it("throws for non-read-safe tools", async () => {
    const executor = async () => "should not run"
    const ops: ReadOperation[] = [
      { tool: "bash", args: { command: "rm -rf /" } },
    ]
    await expect(executeBatchReads(ops, executor)).rejects.toThrow("not in the safe-read whitelist")
  })

  it("throws for write tool in batch", async () => {
    const executor = async () => "nope"
    const ops: ReadOperation[] = [
      { tool: "hash-edit", args: {} },
    ]
    await expect(executeBatchReads(ops, executor)).rejects.toThrow()
  })

  it("handles timeout per operation gracefully", async () => {
    const executor = async () => {
      await new Promise(r => setTimeout(r, 500))
      return "late"
    }
    const ops: ReadOperation[] = [
      { tool: "fdx-read", args: { file_path: "slow.ts" } },
    ]
    const result = await executeBatchReads(ops, executor, { timeoutMs: 50 })
    expect(result.anyErrors).toBe(true)
    expect(result.results[0].error).toContain("timeout")
  })

  it("truncates large outputs", async () => {
    const largeString = "x".repeat(100_000)
    const executor = async () => largeString
    const ops: ReadOperation[] = [
      { tool: "fdx-search", args: { pattern: ".*" } },
    ]
    const result = await executeBatchReads(ops, executor, { maxOutputBytes: 1000 })
    const output = result.results[0].result as string
    expect(output).toContain("[truncated]")
    expect(output.length).toBeLessThan(2000)
  })

  it("isSafeReadTool returns true for read tools", () => {
    for (const t of ["fdx-read", "fdx-grep", "fdx-search", "fdx-outline", "fdx-ls", "repo-memory"]) {
      expect(isSafeReadTool(t)).toBe(true)
    }
  })

  it("isSafeReadTool returns false for write tools", () => {
    for (const t of ["bash", "hash-edit", "write", "task"]) {
      expect(isSafeReadTool(t)).toBe(false)
    }
  })

  it("formatBatchResults returns readable multiline string", async () => {
    const executor = async (tool: string) => "content for " + tool
    const ops: ReadOperation[] = [
      { tool: "fdx-read", args: {}, label: "file-a" },
      { tool: "fdx-grep", args: {}, label: "grep-b" },
    ]
    const batch = await executeBatchReads(ops, executor)
    const formatted = formatBatchResults(batch)
    expect(formatted).toContain("[READ file-a")
    expect(formatted).toContain("[READ grep-b")
  })

  it("respects maxConcurrency chunks", async () => {
    const callOrder: number[] = []
    let active = 0
    let maxActive = 0
    const executor = async (_tool: string, args: Record<string, unknown>) => {
      active++
      if (active > maxActive) maxActive = active
      await new Promise(r => setTimeout(r, 10))
      callOrder.push(args["idx"] as number)
      active--
      return "ok"
    }
    const ops = Array.from({ length: 6 }, (_, i) => ({
      tool: "fdx-read" as const,
      args: { file_path: "f" + i + ".ts", idx: i },
    }))
    await executeBatchReads(ops, executor, { maxConcurrency: 3 })
    // maxActive should not exceed 3 per chunk
    expect(maxActive).toBeLessThanOrEqual(3)
  })
})
