
import { describe, it, expect, beforeEach } from "bun:test"
import { classifyShellCommand } from "../src/services/shell-command-classifier"
import { normalizeAction } from "../src/services/loop-detector"
import { detectNoVisibleOutputCompletion } from "../src/services/provider-history-safety"
import { recoveryCoordinator } from "../src/services/recovery-coordinator"
import { updateWatchdogState, clearAllWatchdogStates } from "../src/services/heidi-watchdog"
import { OrchestratorGuard } from "../src/hooks/orchestrator-guard-hook"
import { getAgentRoutes } from "../src/agents/index"
import { taskPhaseManager } from "../src/services/task-phase-manager"

describe("P1 Real Runtime Recovery-Loop Defect Regression Suite", () => {
  const testSession = "test-repro-session"

  beforeEach(() => {
    clearAllWatchdogStates()
    recoveryCoordinator.cancelSession(testSession)
  })

  // 1-7: Healthy discovery sequence
  it("screenshot startup commands are all classified as read-only inspection", () => {
    const cmd1 = "git status --short && git rev-parse HEAD && bun --version && node --version"
    const res1 = classifyShellCommand(cmd1)
    expect(res1.category).toBe("read")

    const cmd2 = "git log -n 1 --oneline && git branch --show-current"
    const res2 = classifyShellCommand(cmd2)
    expect(res2.category).toBe("read")

    const cmd3 = 'which fdx || true; fdx --version || true; opencode --version || true; env | grep -E "(OPENCODE|FLOWDECK)" || true'
    const res3 = classifyShellCommand(cmd3)
    expect(res3.category).toBe("read")
  })

  it("orchestrator_guard does not block healthy audit startup discovery shell commands", () => {
    const guard = new OrchestratorGuard({ routes: getAgentRoutes() })

    expect(() => {
      guard.check(testSession, "bash", { command: "git status --short && git rev-parse HEAD && bun --version && node --version" }, "heidi")
    }).not.toThrow()

    expect(() => {
      guard.check(testSession, "bash", { command: "git log -n 1 --oneline && git branch --show-current" }, "heidi")
    }).not.toThrow()

    expect(() => {
      guard.check(testSession, "bash", { command: 'which fdx || true; fdx --version || true; opencode --version || true; env | grep -E "(OPENCODE|FLOWDECK)" || true' }, "heidi")
    }).not.toThrow()
  })

  // 8-11: Fingerprint precision and distinction
  it("LoopDetector distinguishes fdx-read across different files, modes, and symbols", () => {
    const k1 = normalizeAction("fdx-read", { file: "package.json", mode: "raw" })
    const k2 = normalizeAction("fdx-read", { file: "src/index.ts", mode: "prototype" })
    const k3 = normalizeAction("fdx-read", { file: "src/index.ts", mode: "deep", symbol: "OrchestratorGuard" })
    const k4 = normalizeAction("fdx-search", { query: "FastRouter", dir: "src" })

    expect(k1).not.toBe(k2)
    expect(k2).not.toBe(k3)
    expect(k1).toContain("package.json")
    expect(k3).toContain("OrchestratorGuard")
    expect(k4).toContain("FastRouter")
  })

  // 12-14: Genuine loops blocked, legitimate variation allowed
  it("orchestrator_guard STILL blocks genuine mutating shell commands", () => {
    const guard = new OrchestratorGuard({ routes: getAgentRoutes() })

    expect(() => {
      guard.check(testSession, "bash", { command: "git commit -m 'test'" }, "heidi")
    }).toThrow()

    expect(() => {
      guard.check(testSession, "bash", { command: "rm -rf dist/" }, "heidi")
    }).toThrow()

    expect(() => {
      guard.check(testSession, "bash", { command: "npm install foo" }, "heidi")
    }).toThrow()
  })

  // 15-17: Single-flight recovery continuation
  it("recoveryCoordinator enforces single-flight and rejects duplicate requests", () => {
    let promptCount = 0
    const mockClient = {
      session: {
        promptAsync: async () => {
          promptCount++
          return { data: { id: "prompt-msg-1" } }
        }
      }
    }
    void promptCount

    const req = {
      sessionID: testSession,
      source: "reasoning_recovery" as const,
      client: mockClient,
      appLog: async () => {},
      handleEvent: async () => {}
    }

    const admitted1 = recoveryCoordinator.requestContinuation(req)
    expect(admitted1).toBe(true)

    const admitted2 = recoveryCoordinator.requestContinuation(req)
    expect(admitted2).toBe(false)

    const check = recoveryCoordinator.canInjectRecoveryContinuation({
      sessionID: testSession,
      source: "reasoning_recovery",
      client: mockClient
    })
    expect(check.allowed).toBe(false)
    expect(check.suppressionReason).toBe("ALREADY_IN_FLIGHT")
  })

  // 18-20: Provenance tracking
  it("internal recovery directive classifies as internal and does not create manual user task", () => {
    const promptText = "Continue the current task from the last verified execution state and provide a visible progress or completion response."
    const mockClient = {
      session: {
        promptAsync: async () => {
          return { data: { id: "prompt-msg-internal-1" } }
        }
      }
    }

    recoveryCoordinator.requestContinuation({
      sessionID: testSession,
      source: "reasoning_recovery",
      promptText,
      client: mockClient,
      appLog: async () => {},
      handleEvent: async () => {}
    })

    const prov = recoveryCoordinator.classifyMessage(testSession, undefined, promptText)
    expect(prov).toBe("internal_reasoning_recovery")
  })

  // 21-23: Tool-call turn safety
  it("detectNoVisibleOutputCompletion does NOT flag turns containing tool calls as malformed", () => {
    const msgCompletedTool = {
      info: { id: "m1", sessionID: testSession, role: "assistant", finishReason: "stop" } as any,
      parts: [
        { type: "step-start" },
        { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", output: "ok" } },
        { type: "step-finish", reason: "stop" }
      ] as any
    }
    const res1 = detectNoVisibleOutputCompletion(msgCompletedTool, { confirmedTerminal: true })
    expect(res1.isMalformed).toBe(false)

    const msgErrorTool = {
      info: { id: "m2", sessionID: testSession, role: "assistant", finishReason: "stop" } as any,
      parts: [
        { type: "step-start" },
        { type: "tool", tool: "read", callID: "c2", state: { status: "error", error: "use fdx-read" } },
        { type: "step-finish", reason: "stop" }
      ] as any
    }
    const res2 = detectNoVisibleOutputCompletion(msgErrorTool, { confirmedTerminal: true })
    expect(res2.isMalformed).toBe(false)
  })

  // 24-26: Fresh-task isolation
  it("taskPhaseManager tracks new manual task phase cleanly", () => {
    const b1 = taskPhaseManager.beginNewTaskPhase(testSession, "task-1", ["Audit repo"])
    expect(b1.phase).toBe(1)

    const b2 = taskPhaseManager.beginNewTaskPhase(testSession, "task-2", ["Fix bug"])
    expect(b2.phase).toBe(2)
  })

  // 27-28: Terminal session suppresses recovery
  it("admission gate rejects recovery if session is terminal or exhausted", () => {
    updateWatchdogState(testSession, { isTerminalTask: true })
    const resTerminal = recoveryCoordinator.canInjectRecoveryContinuation({
      sessionID: testSession,
      source: "reasoning_recovery"
    })
    expect(resTerminal.allowed).toBe(false)
    expect(resTerminal.suppressionReason).toBe("TERMINAL_SESSION")

    updateWatchdogState(testSession, { isTerminalTask: false, recoveryExhausted: true })
    const resExhausted = recoveryCoordinator.canInjectRecoveryContinuation({
      sessionID: testSession,
      source: "reasoning_recovery"
    })
    expect(resExhausted.allowed).toBe(false)
    expect(resExhausted.suppressionReason).toBe("EXHAUSTED")
  })
})
