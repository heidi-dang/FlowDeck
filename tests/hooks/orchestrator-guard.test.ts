import { describe, it, expect, beforeEach } from "bun:test"
import { OrchestratorGuard } from "@/hooks/orchestrator-guard-hook"
import { isRecoverableBlockError } from "@/services/recoverable-block"

describe("OrchestratorGuard: Heidi Direct Execution & Alias Normalization", () => {
  let guard: OrchestratorGuard

  beforeEach(() => {
    guard = new OrchestratorGuard({
      routes: [
        { name: "backend-coder", description: "Implements backend features and fixes." },
        { name: "coder", description: "Implements backend/frontend/devops." },
      ],
    })
    guard._setPrimarySessionIdForTest("primary-session")
  })

  it("permits direct execution of file tools for heidi and orchestrator alias", () => {
    const directTools = ["write", "write_file", "edit", "edit_file", "patch", "apply_patch", "create_file"]

    for (const tool of directTools) {
      expect(() => guard.check("primary-session", tool, {}, "heidi")).not.toThrow()
      expect(() => guard.check("primary-session", tool, {}, "orchestrator")).not.toThrow()
    }
  })

  it("permits safe read-only and project shell inspection commands for heidi", () => {
    expect(() => guard.check("primary-session", "bash", { command: "ls -la" }, "heidi")).not.toThrow()
    expect(() => guard.check("primary-session", "bash", { command: "git status" }, "heidi")).not.toThrow()
    expect(() => guard.check("primary-session", "bash", { command: "gh api repos/owner/repo/commits" }, "heidi")).not.toThrow()
  })

  it("blocks sensitive-read shell commands with a RecoverableFlowDeckBlockError", () => {
    let err: unknown = null
    try {
      guard.check("primary-session", "bash", { command: "cat .env" }, "heidi")
    } catch (e) {
      err = e
    }

    expect(err).not.toBeNull()
    expect(isRecoverableBlockError(err)).toBe(true)
    if (isRecoverableBlockError(err)) {
      expect(err.subsystem).toBe("orchestrator_guard")
      expect(err.code).toBe("ORCHESTRATOR_GUARD_SENSITIVE_READ")
    }
  })

  it("blocks risky shell commands with a RecoverableFlowDeckBlockError", () => {
    let err: unknown = null
    try {
      guard.check("primary-session", "bash", { command: "ssh user@remote" }, "heidi")
    } catch (e) {
      err = e
    }

    expect(err).not.toBeNull()
    expect(isRecoverableBlockError(err)).toBe(true)
    if (isRecoverableBlockError(err)) {
      expect(err.subsystem).toBe("orchestrator_guard")
      expect(err.code).toBe("ORCHESTRATOR_GUARD_RISKY_SHELL")
    }
  })

  it("returns formatted routing options hint for diagnostic reporting", () => {
    const hint = guard._getRoutingOptionsForTest()
    expect(hint).toContain("@backend-coder")
    expect(hint).toContain("@coder")
  })
})
