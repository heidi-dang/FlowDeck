/**
 * Heidi Orchestrator Guard Flood & Retry Loop Regression Tests
 *
 * Covers:
 * 1. Read-only inspection classification for normal developer commands (node -p, bun test, etc.)
 * 2. Bounded identical blocked-action policy (no infinite retry loop)
 * 3. Stable fingerprinting with session, tool, args, cwd, and reason
 * 4. Structured Recoverable Block feedback and replan alternatives
 * 5. Watchdog state cleanup and zero-leak invariants
 * 6. Audit and event deduplication
 * 7. Full Heidi repository audit smoke sequence with deliberate blocked command & recovery
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { classifyShellCommand } from "../src/services/shell-command-classifier"
import { OrchestratorGuard } from "../src/hooks/orchestrator-guard-hook"
import { orchestratorGuardStrategyCircuit, normalizeGuardFingerprint } from "../src/services/orchestrator-guard-strategy-circuit"
import { RecoverableFlowDeckBlockError, isRecoverableBlockError } from "../src/services/recoverable-block"
import { getAgentRoutes } from "../src/agents/index"
import { clearAllWatchdogStates, getWatchdogState } from "../src/services/heidi-watchdog"
import flowDeckPlugin from "../src/index"
import { auditLogPath } from "../src/services/audit-log"
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("Heidi v2.2.5 Orchestrator Guard Hotfix Regressions", () => {
  const sessionID = "ses_heidi_regression_test"

  beforeEach(() => {
    orchestratorGuardStrategyCircuit.clearAll()
    clearAllWatchdogStates()
  })

  describe("1. Correct Shell Command Classification for Repository Inspection", () => {
    it("classifies node -p and node --print version/inspection queries as read-only", () => {
      const res1 = classifyShellCommand('node -p \'require("./package.json").version\'')
      expect(res1.category).toBe("read")
      expect(res1.reason).toContain("read-only")

      const res2 = classifyShellCommand('node --print \'require("./package.json").name\'')
      expect(res2.category).toBe("read")

      const res3 = classifyShellCommand('node -p "process.arch"')
      expect(res3.category).toBe("read")
    })

    it("classifies bun test and focused test executions as read-only test verification", () => {
      const res1 = classifyShellCommand("bun test tests/hooks/orchestrator-guard.test.ts")
      expect(res1.category).toBe("read")

      const res2 = classifyShellCommand("bun test")
      expect(res2.category).toBe("read")

      const res3 = classifyShellCommand("bun run test")
      expect(res3.category).toBe("read")
    })

    it("classifies cargo test, cargo check, cargo clippy, cargo fmt check as read-only", () => {
      const res1 = classifyShellCommand("cargo test --all")
      expect(res1.category).toBe("read")

      const res2 = classifyShellCommand("cargo check")
      expect(res2.category).toBe("read")

      const res3 = classifyShellCommand("cargo clippy --all-targets")
      expect(res3.category).toBe("read")

      const res4 = classifyShellCommand("cargo fmt --check")
      expect(res4.category).toBe("read")
    })

    it("classifies npm test and pnpm test as read-only", () => {
      const res1 = classifyShellCommand("npm test")
      expect(res1.category).toBe("read")

      const res2 = classifyShellCommand("pnpm test")
      expect(res2.category).toBe("read")
    })

    it("classifies full canonical audit discovery pipeline as read-only", () => {
      const pipeline = "pwd && git status --short --branch && git rev-parse HEAD && git log --oneline -10 && ls && cat package.json && node -p 'require(\"./package.json\").version' && bun test"
      const res = classifyShellCommand(pipeline)
      expect(res.category).toBe("read")
    })

    it("STILL blocks genuine mutating or destructive commands", () => {
      expect(classifyShellCommand("rm -rf /tmp/test").category).toBe("mutating")
      expect(classifyShellCommand("git commit -m 'test'").category).toBe("mutating")
      expect(classifyShellCommand("git push origin main").category).toBe("risky")
      expect(classifyShellCommand("npm install lodash").category).toBe("mutating")
      expect(classifyShellCommand("bun add lodash").category).toBe("mutating")
      expect(classifyShellCommand("cargo publish").category).toBe("mutating")
      expect(classifyShellCommand("cargo build").category).toBe("mutating")
      expect(classifyShellCommand("cat .env").category).toBe("sensitive-read")
      expect(classifyShellCommand("ssh user@host").category).toBe("risky")
      expect(classifyShellCommand("node -e 'fs.unlinkSync(\"foo\")'").category).toBe("unknown")
    })
  })

  describe("2. Bounded Blocked-Action Policy & Fingerprinting", () => {
    it("includes cwd and normalized args in stable guard fingerprint", () => {
      const fp1 = normalizeGuardFingerprint("bash", { command: "rm -rf dist", cwd: "/app" })
      const fp2 = normalizeGuardFingerprint("bash", { command: "rm -rf   dist", cwd: "/app" })
      const fp3 = normalizeGuardFingerprint("bash", { command: "rm -rf dist", cwd: "/other" })

      expect(fp1).toBe(fp2)
      expect(fp1).not.toBe(fp3)
    })

    it("terminates immediately on unchanged identical blocked retry (Attempt 1 recoverable -> Attempt 2 terminal)", () => {
      const guard = new OrchestratorGuard({ routes: getAgentRoutes() })
      guard._setPrimarySessionIdForTest(sessionID)

      // Attempt 1: Blocked with recoverable structured error
      let err1: any = null
      try {
        guard.check(sessionID, "bash", { command: "rm -rf dist" }, "heidi")
      } catch (e) {
        err1 = e
      }
      expect(err1).not.toBeNull()
      expect(isRecoverableBlockError(err1)).toBe(true)
      expect(err1.recoverable).toBe(true)
      expect(err1.terminal).toBe(false)
      expect(err1.code).toBe("ORCHESTRATOR_GUARD_MUTATING_SHELL")

      // Attempt 2: Identical command + unchanged state -> Terminal block (no 3+ attempt loop)
      let err2: any = null
      try {
        guard.check(sessionID, "bash", { command: "rm -rf dist" }, "heidi")
      } catch (e) {
        err2 = e
      }
      expect(err2).not.toBeNull()
      expect(isRecoverableBlockError(err2)).toBe(true)
      expect(err2.recoverable).toBe(false)
      expect(err2.terminal).toBe(true)
      expect(err2.code).toBe("ORCHESTRATOR_GUARD_STRATEGY_INVALIDATED")
    })

    it("allows a different tool or command after a block without inheriting termination", () => {
      const guard = new OrchestratorGuard({ routes: getAgentRoutes() })
      guard._setPrimarySessionIdForTest(sessionID)

      // Blocked mutating command
      expect(() => guard.check(sessionID, "bash", { command: "rm -rf dist" }, "heidi")).toThrow()

      // Safe read command succeeds immediately
      expect(() => guard.check(sessionID, "bash", { command: "git status" }, "heidi")).not.toThrow()
    })

    it("resets blocked state when repo generation changes (meaningful state transition)", () => {
      const guard = new OrchestratorGuard({ routes: getAgentRoutes() })
      guard._setPrimarySessionIdForTest(sessionID)

      // Blocked in gen 1
      orchestratorGuardStrategyCircuit.recordAllowedProgress(sessionID, "gen-1")
      expect(() => guard.check(sessionID, "bash", { command: "rm -rf dist" }, "heidi")).toThrow()

      // State transitions to gen 2 (e.g. after specialist write)
      orchestratorGuardStrategyCircuit.recordAllowedProgress(sessionID, "gen-2")

      // Attempt 1 in gen-2 is fresh (recoverable, not terminal)
      let err: any = null
      try {
        guard.check(sessionID, "bash", { command: "rm -rf dist" }, "heidi")
      } catch (e) {
        err = e
      }
      expect(err.recoverable).toBe(true)
      expect(err.terminal).toBe(false)
    })
  })

  describe("3. Structured Recoverable Block Semantics & Heidi Feedback", () => {
    it("formats actionable alternatives and disallows identical unchanged retry in feedback", () => {
      const err = new RecoverableFlowDeckBlockError({
        subsystem: "orchestrator_guard",
        code: "ORCHESTRATOR_GUARD_MUTATING_SHELL",
        tool: "bash",
        sessionID,
        agent: "heidi",
        reason: "Mutating shell commands must be routed to a specialist agent.",
        recoverable: true,
        suggestedActions: [
          "Route mutation to specialist agent (@coder, @backend-coder) via task tool",
          "Use FDX read tools (fdx-read, fdx-search) if inspection was intended",
        ],
      })

      const feedback = err.toFeedbackString()
      expect(feedback).toContain("[FlowDeck Guard Notice - Action Required]")
      expect(feedback).toContain("ORCHESTRATOR_GUARD_MUTATING_SHELL")
      expect(feedback).toContain("@coder")
      expect(feedback).toContain("fdx-read")
      expect(feedback).toContain("Do NOT repeat this identical command unchanged")
    })
  })

  describe("4. Tool Execute Lifecycle: Zero State-Leak on Guard Block", () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = join(tmpdir(), `fd-test-guard-leak-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(join(tmpDir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))
    })

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
    })

    it("decrements active tools and cleans watchdog pending state when orchestrator guard blocks", async () => {
      const pluginInstance = (await flowDeckPlugin.server({
        directory: tmpDir,
        client: { app: { log: async () => {} } },
      } as any)) as any

      // Initialize session
      await pluginInstance["event"]({
        event: {
          type: "session.created",
          properties: { info: { id: sessionID, agent: "heidi" } },
        },
      })
      await pluginInstance["chat.message"](
        { sessionID, agent: "heidi" },
        { message: { agent: "heidi", system: "" } as any },
      )

      // Invoke a blocked command through tool.execute.before
      const toolInput = { tool: "bash", sessionID, callID: "call-1", args: { command: "rm -rf dist" } }
      const toolOutput = { args: { command: "rm -rf dist" } }

      let thrown = false
      try {
        await pluginInstance["tool.execute.before"](toolInput, toolOutput)
      } catch (err) {
        thrown = true
        expect(isRecoverableBlockError(err)).toBe(true)
      }
      expect(thrown).toBe(true)

      // Verify watchdog isPendingTool is NOT stuck at true!
      const wState = getWatchdogState(sessionID)
      expect(wState?.isPendingTool).toBe(false)
    })
  })

  describe("5. End-to-End Heidi Audit & Replan Smoke Scenario", () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = join(tmpdir(), `fd-test-audit-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(join(tmpDir, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "flowdeck-antigravity", version: "2.2.5" }))
    })

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
    })

    it("executes healthy full audit startup discovery without any blocks", async () => {
      const pluginInstance = (await flowDeckPlugin.server({
        directory: tmpDir,
        client: { app: { log: async () => {} } },
      } as any)) as any

      const auditSession = "ses_audit_smoke_healthy"
      await pluginInstance["event"]({
        event: {
          type: "session.created",
          properties: { info: { id: auditSession, agent: "heidi" } },
        },
      })
      await pluginInstance["chat.message"](
        { sessionID: auditSession, agent: "heidi" },
        { message: { agent: "heidi", system: "" } as any },
      )

      // Discovery sequence that previously flooded in v2.2.5
      const discoveryCommands = [
        "pwd",
        "git status --short --branch",
        "git rev-parse HEAD",
        "git log --oneline -10",
        "ls",
        "cat package.json",
        'node -p \'require("./package.json").version\'',
        "bun test",
      ]

      for (let i = 0; i < discoveryCommands.length; i++) {
        const cmd = discoveryCommands[i]
        const toolInput = { tool: "bash", sessionID: auditSession, callID: `call-audit-${i}`, args: { command: cmd } }
        const toolOutput = { args: { command: cmd } }

        // All should succeed without throwing
        await expect(pluginInstance["tool.execute.before"](toolInput, toolOutput)).resolves.toBeUndefined()
      }
    })

    it("handles an unsafe mutating attempt with exactly one guard log event and replans cleanly", async () => {
      const pluginInstance = (await flowDeckPlugin.server({
        directory: tmpDir,
        client: { app: { log: async () => {} } },
      } as any)) as any

      const auditSession = "ses_audit_smoke_unsafe"
      await pluginInstance["event"]({
        event: {
          type: "session.created",
          properties: { info: { id: auditSession, agent: "heidi" } },
        },
      })
      await pluginInstance["chat.message"](
        { sessionID: auditSession, agent: "heidi" },
        { message: { agent: "heidi", system: "" } as any },
      )

      // Step 1: Unsafe command is attempted
      const unsafeInput = { tool: "bash", sessionID: auditSession, callID: "call-unsafe-1", args: { command: "rm -rf src/" } }
      const unsafeOutput = { args: { command: "rm -rf src/" } }

      let thrownErr: any = null
      try {
        await pluginInstance["tool.execute.before"](unsafeInput, unsafeOutput)
      } catch (e) {
        thrownErr = e
      }

      expect(thrownErr).not.toBeNull()
      expect(isRecoverableBlockError(thrownErr)).toBe(true)
      expect(thrownErr.code).toBe("ORCHESTRATOR_GUARD_MUTATING_SHELL")
      expect(thrownErr.recoverable).toBe(true)

      // Step 2: Verify audit log has exactly 1 guard.block event for this call
      const auditFile = auditLogPath(tmpDir)
      expect(existsSync(auditFile)).toBe(true)
      const auditLines = readFileSync(auditFile, "utf-8").trim().split(/\r?\n/).map(l => JSON.parse(l))
      const guardBlocks = auditLines.filter(e => e.kind === "guard.block" && e.session_id === auditSession)
      expect(guardBlocks.length).toBe(1)
      expect(guardBlocks[0].details.callID).toBe("call-unsafe-1")

      // Step 3: Replan — Heidi chooses safe inspection tool (read) instead of retrying rm -rf
      const fallbackInput = { tool: "read", sessionID: auditSession, callID: "call-fallback-1", args: { filePath: "package.json" } }
      const fallbackOutput = { args: { filePath: "package.json" } }

      await expect(pluginInstance["tool.execute.before"](fallbackInput, fallbackOutput)).resolves.toBeUndefined()
    })
  })
})
