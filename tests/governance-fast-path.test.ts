import { describe, it, expect } from "bun:test"
import {
  governanceFastPath,
  isSafeReadTool,
  isHighRiskTool,
} from "../src/services/governance-fast-path"

describe("GovernanceFastPath — Milestone F2", () => {
  // Required: governance read fast-path < 5ms p50
  it("fast-path authorizes safe read tools in advisory mode (< 2ms p50)", () => {
    const N = 1000
    const start = Date.now()
    for (let i = 0; i < N; i++) {
      governanceFastPath("fdx-read", "advisory")
    }
    const elapsed = Date.now() - start
    const p50 = elapsed / N
    expect(p50).toBeLessThan(2)
  })

  it("allows safe read tools in advisory mode via fast path", () => {
    const result = governanceFastPath("fdx-read", "advisory")
    expect(result.allowed).toBe(true)
    expect(result.usedFastPath).toBe(true)
  })

  it("allows safe read tools in strict mode via fast path", () => {
    const result = governanceFastPath("fdx-grep", "strict")
    expect(result.allowed).toBe(true)
    expect(result.usedFastPath).toBe(true)
  })

  it("allows everything in off mode", () => {
    const result = governanceFastPath("bash", "off")
    expect(result.allowed).toBe(true)
    expect(result.usedFastPath).toBe(true)
  })

  // Required: high-risk operations still receive full policy evaluation
  it("blocks bash and requires full policy in advisory mode", () => {
    const result = governanceFastPath("bash", "advisory")
    expect(result.allowed).toBe(false)
    expect(result.usedFastPath).toBe(false)
    expect(result.reason).toContain("HIGH_RISK")
  })

  it("blocks hash-edit and requires full policy in strict mode", () => {
    const result = governanceFastPath("hash-edit", "strict")
    expect(result.allowed).toBe(false)
    expect(result.usedFastPath).toBe(false)
    expect(result.reason).toContain("HIGH_RISK")
  })

  it("blocks task tool from fast path", () => {
    const result = governanceFastPath("task", "advisory")
    expect(result.allowed).toBe(false)
    expect(result.usedFastPath).toBe(false)
  })

  it("blocks unknown tools from fast path", () => {
    const result = governanceFastPath("some-unknown-tool", "advisory")
    expect(result.allowed).toBe(false)
    expect(result.usedFastPath).toBe(false)
    expect(result.reason).toContain("UNKNOWN_TOOL")
  })

  it("blocks filesystem root path even for read tools", () => {
    const result = governanceFastPath("fdx-read", "advisory", "/")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("FILESYSTEM_ROOT")
  })

  it("isSafeReadTool correctly identifies all whitelisted read tools", () => {
    const tools = ["fdx-read", "fdx-grep", "fdx-search", "fdx-outline", "fdx-ls", "fdx-tree",
      "fdx-diff", "fdx-git", "fdx-impact", "fdx-context", "repo-memory", "codegraph"]
    for (const t of tools) {
      expect(isSafeReadTool(t)).toBe(true)
    }
  })

  it("isHighRiskTool correctly identifies write/exec tools", () => {
    for (const t of ["bash", "hash-edit", "write", "edit", "apply_patch", "task", "computer"]) {
      expect(isHighRiskTool(t)).toBe(true)
    }
  })

  it("read tools not in whitelist are not safe read tools", () => {
    expect(isSafeReadTool("bash")).toBe(false)
    expect(isSafeReadTool("write")).toBe(false)
    expect(isSafeReadTool("task")).toBe(false)
  })
})
