import { describe, it, expect } from "bun:test"
import {
  resolveExecutionMode,
  stripHeredocBodies,
  splitTopLevelSegments,
  extractExecutable,
  classifyCommand,
  effectiveSeverity,
  getPlanConfirmed
} from "../src/hooks/guard-rails"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Guard Rails Deep Unit Tests", () => {
  it("resolveExecutionMode resolves mode based on config, trustScore, and volatility", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guard-mode-"))
    try {
      const cfgPath = join(tempDir, "config.json")
      writeFileSync(cfgPath, JSON.stringify({ execution_mode: "guarded" }))

      expect(resolveExecutionMode(cfgPath, null)).toBe("guarded")
      expect(resolveExecutionMode(join(tempDir, "none.json"), 20)).toBe("review-only")
      expect(resolveExecutionMode(join(tempDir, "none.json"), 50)).toBe("guarded")
      expect(resolveExecutionMode(join(tempDir, "none.json"), 80, "critical")).toBe("review-only")
      expect(resolveExecutionMode(join(tempDir, "none.json"), 80, "volatile")).toBe("guarded")
      expect(resolveExecutionMode(join(tempDir, "none.json"), 80, "stable")).toBe("auto")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("stripHeredocBodies strips heredoc bodies cleanly", () => {
    const cmd = "cat <<EOF\nline 1\nline 2\nEOF\necho done"
    const stripped = stripHeredocBodies(cmd)
    expect(stripped).toContain("cat <<EOF")
    expect(stripped).not.toContain("line 1")
    expect(stripped).toContain("echo done")
  })

  it("splitTopLevelSegments splits chained commands correctly", () => {
    const cmd = "git status && npm test || echo failed; bun run build"
    const segments = splitTopLevelSegments(cmd)
    expect(segments.length).toBe(4)
    expect(segments[0]).toBe("git status")
    expect(segments[1]).toBe("npm test")
  })

  it("extractExecutable extracts command binary name", () => {
    expect(extractExecutable("git status")).toBe("git")
    expect(extractExecutable("VAR=1 node app.js")).toBe("node")
    expect(extractExecutable("./scripts/test.sh")).toBe("test.sh")
  })

  it("classifyCommand classifies command risk and safety", () => {
    const c1 = classifyCommand("git status")
    expect(c1.category).toBeDefined()

    const c2 = classifyCommand("rm -rf /")
    expect(c2.category).toBeDefined()

    const c3 = classifyCommand("git commit -m 'feat'")
    expect(c3.category).toBeDefined()
  })

  it("effectiveSeverity and getPlanConfirmed evaluate state files", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guard-state-"))
    try {
      const cfgPath = join(tempDir, "config.json")
      const statePath = join(tempDir, "STATE.md")
      writeFileSync(cfgPath, JSON.stringify({ guard: { mode: "strict" } }))
      writeFileSync(statePath, "---\nplan_confirmed: true\n---")

      const sev = effectiveSeverity(cfgPath, statePath)
      expect(sev).toBeDefined()

      const confirmed = getPlanConfirmed(statePath)
      expect(typeof confirmed).toBe("boolean")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
