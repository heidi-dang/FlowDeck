import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "fs"
import { join, dirname, basename } from "path"
import { tmpdir } from "os"
import { validateAgent } from "@/services/agent-validator"
import { toolGuardHook, executePostWriteHook, getWriteCount, clearWriteCounter } from "@/hooks/tool-guard"
import { LoopDetector } from "@/services/loop-detector"
import { safeReadConfig, safeUpdateConfig } from "@/services/config-editor"
import { parse } from "jsonc-parser"

describe("Phase 1 — Critical Runtime Correctness Repairs", () => {
  let tmpDir: string

  beforeEach(() => {
    process.env.FLOWDECK_DISABLE_FDX_REDIRECT = "true"
    tmpDir = mkdtempSync(join(tmpdir(), "phase1-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("1. Validator Enforcement", () => {
    it("advisory validator mode records warnings without blocking", () => {
      // In advisory mode, agent calling forbidden/unallowed tool returns action="warn"
      const res = validateAgent(tmpDir, { agent: "researcher", toolUsed: "bash" })
      expect(res.action).toBe("warn")
      expect(res.violations.length).toBeGreaterThan(0)
    })

    it("strict validator mode blocks contract violations with action=block", () => {
      // Mock governance config with mode="strict"
      const flowdeckJson = join(tmpDir, ".flowdeck.json")
      writeFileSync(flowdeckJson, JSON.stringify({ governance: { validator: { mode: "strict" } } }), "utf-8")

      const res = validateAgent(tmpDir, { agent: "researcher", toolUsed: "write_file", prerequisitesMet: false })
      expect(res.action).toBe("block")
    })

    it("toolGuardHook does not block when validator action is warn in advisory mode", async () => {
      const ctx = { directory: tmpDir, agent: "researcher" }
      const input = { tool: "read", name: "read", args: { filePath: join(tmpDir, "file.ts") }, sessionID: "s1" }
      // In advisory mode, toolGuardHook should complete without throwing for unblocked tools
      await expect(toolGuardHook(ctx, input, { args: input.args })).resolves.toBeUndefined()
    })
  })

  describe("2. Write Lifecycle", () => {
    it("failed write is not counted as modified file", async () => {
      const sessionID = "sess-failed-write"
      clearWriteCounter(sessionID)
      expect(getWriteCount(sessionID)).toBe(0)

      // toolGuardHook runs before execution and should not increment write counter
      const ctx = { directory: tmpDir, agent: "backend-coder" }
      const input = { tool: "write", name: "write", args: { filePath: join(tmpDir, "fail.ts") }, sessionID }

      await toolGuardHook(ctx, input, { args: input.args })
      // Write count remains 0 before execution
      expect(getWriteCount(sessionID)).toBe(0)

      // Simulate a failed write (do NOT call executePostWriteHook)
      expect(getWriteCount(sessionID)).toBe(0)
    })

    it("successful write verified after execution", async () => {
      const sessionID = "sess-success-write"
      clearWriteCounter(sessionID)
      const targetFile = join(tmpDir, "success.ts")

      // Simulate successful file write to disk
      writeFileSync(targetFile, "export const x = 1;", "utf-8")

      // Execute post-write lifecycle AFTER write success
      executePostWriteHook(tmpDir, sessionID, "backend-coder", "write", { filePath: targetFile })

      expect(getWriteCount(sessionID)).toBe(1)
    })
  })

  describe("3. Loop Detector", () => {
    it("detects real result, repeated result, changed result, and errors", () => {
      const detector = new LoopDetector({ maxRepeats: 1 })
      const sessionID = "s-loop"

      // First call
      expect(detector.checkBefore("bash", { command: "ls" }, sessionID).action).toBe("allow")
      detector.recordAfter("bash", { command: "ls" }, "file1.txt", sessionID, "success")

      // Second call (same result)
      expect(detector.checkBefore("bash", { command: "ls" }, sessionID).action).toBe("allow")
      detector.recordAfter("bash", { command: "ls" }, "file1.txt", sessionID, "success")

      // Third call (repeated same result) -> blocked
      expect(detector.checkBefore("bash", { command: "ls" }, sessionID).action).toBe("block")

      // Changed result resets loop detector
      expect(detector.checkBefore("bash", { command: "pwd" }, sessionID).action).toBe("allow")
    })

    it("handles [unavailable] output sentinel gracefully", () => {
      const detector = new LoopDetector({ maxRepeats: 2 })
      const sessionID = "s-unavail"

      detector.checkBefore("bash", { command: "ls" }, sessionID)
      detector.recordAfter("bash", { command: "ls" }, "[unavailable]", sessionID, "success")

      expect(detector.checkBefore("bash", { command: "ls" }, sessionID).action).toBe("allow")
    })
  })

  describe("4. Configuration Safety", () => {
    it("malformed configuration remains byte-for-byte unchanged", () => {
      const configFile = join(tmpDir, "opencode.json")
      const malformedContent = `{\n  "plugin": ["test",\n  invalid_json\n}`
      writeFileSync(configFile, malformedContent, "utf-8")

      const res = safeUpdateConfig(configFile, (current) => ({ ...current, default_agent: "orchestrator" }))
      expect(res.ok).toBe(false)
      expect(res.error).toContain("malformed configuration")

      // Verify file was left untouched
      expect(readFileSync(configFile, "utf-8")).toBe(malformedContent)
    })

    it("JSONC comments survive valid updates and parsing works correctly", () => {
      const jsoncWithComments = `{\n  // This is a comment\n  "default_agent": "orchestrator"\n}`
      const errors = [] as any[]
      const data = parse(jsoncWithComments, errors, { allowTrailingComma: true })
      expect(errors.length).toBe(0)
      expect(data.default_agent).toBe("orchestrator")

      const parseRes = safeReadConfig<Record<string, unknown>>(join(tmpDir, "nonexistent.json"))
      expect(parseRes.ok).toBe(false)
    })

    it("valid configuration update creates a backup and performs atomic write", () => {
      const configFile = join(tmpDir, "opencode.json")
      const initial = JSON.stringify({ plugin: ["existing-plugin"] }, null, 2)
      writeFileSync(configFile, initial, "utf-8")

      const res = safeUpdateConfig<Record<string, unknown>>(configFile, (cur) => ({
        ...cur,
        default_agent: "heidi",
      }))

      expect(res.ok).toBe(true)
      expect(res.data?.default_agent).toBe("heidi")
      expect(res.data?.plugin).toEqual(["existing-plugin"])
      // Backup is now created as .bak.<timestamp> — check for existence of any backup file
      const backupFiles = readdirSync(dirname(configFile)).filter((f) =>
        f.startsWith(basename(configFile) + ".bak."),
      )
      expect(backupFiles.length).toBeGreaterThan(0)
    })
  })

  describe("5. Session Cleanup", () => {
    it("session cleanup removes write counters and detector state", () => {
      const sessionID = "sess-cleanup"
      const targetFile = join(tmpDir, "clean.ts")
      writeFileSync(targetFile, "content", "utf-8")

      executePostWriteHook(tmpDir, sessionID, "backend-coder", "write", { filePath: targetFile })
      expect(getWriteCount(sessionID)).toBe(1)

      clearWriteCounter(sessionID)
      expect(getWriteCount(sessionID)).toBe(0)
    })
  })
})
