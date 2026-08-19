/**
 * Unit & Integration Tests for Orchestrator Guard Strategy Circuit & Compound Shell Classifier
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { classifyShellCommand } from "../src/services/shell-command-classifier"
import { orchestratorGuardStrategyCircuit, normalizeGuardFingerprint } from "../src/services/orchestrator-guard-strategy-circuit"

describe("Shell Command Compound Classifier & Lattice", () => {
  it("classifies node --version and node -v as read-only", () => {
    expect(classifyShellCommand("node --version").category).toBe("read")
    expect(classifyShellCommand("node -v").category).toBe("read")
    expect(classifyShellCommand("bun --version").category).toBe("read")
    expect(classifyShellCommand("bun -v").category).toBe("read")
  })

  it("classifies arbitrary node -e as unknown / code execution (governed)", () => {
    expect(classifyShellCommand('node -e "console.log(1)"').category).toBe("unknown")
    expect(classifyShellCommand("node -e 'process.exit(0)'").category).toBe("unknown")
  })

  it("classifies git remote inspection as read-only", () => {
    expect(classifyShellCommand("git remote").category).toBe("read")
    expect(classifyShellCommand("git remote -v").category).toBe("read")
    expect(classifyShellCommand("git remote show origin").category).toBe("read")
  })

  it("classifies mutating git remote subcommands as mutating", () => {
    expect(classifyShellCommand("git remote add origin https://github.com/foo/bar").category).toBe("mutating")
    expect(classifyShellCommand("git remote rm origin").category).toBe("mutating")
    expect(classifyShellCommand("git remote set-url origin https://github.com/foo/bar").category).toBe("mutating")
  })

  it("classifies safe compound commands (A && B) as read-only", () => {
    expect(classifyShellCommand("git remote -v && git branch --show-current").category).toBe("read")
    expect(classifyShellCommand("node --version && bun --version").category).toBe("read")
    expect(classifyShellCommand("command -v fdx && fdx --version").category).toBe("read")
    expect(classifyShellCommand("pwd ; ls -la ; git status").category).toBe("read")
  })

  it("classifies compound commands with mutating segment as mutating", () => {
    expect(classifyShellCommand("git remote -v && git branch -D feature").category).toBe("mutating")
    expect(classifyShellCommand("cat package.json && rm package.json").category).toBe("mutating")
    expect(classifyShellCommand("ls -la ; rm -rf /tmp/test").category).toBe("mutating")
  })

  it("classifies compound commands with unknown segment as unknown", () => {
    expect(classifyShellCommand("git status && node -e 'console.log(1)'").category).toBe("unknown")
  })
})

describe("Orchestrator Guard Strategy Circuit Breaker", () => {
  beforeEach(() => {
    orchestratorGuardStrategyCircuit.clearAll()
  })

  it("normalizes fingerprints identically across whitespace and quote variations", () => {
    const fp1 = normalizeGuardFingerprint("bash", { command: 'node -e "process.exit(17)"' })
    const fp2 = normalizeGuardFingerprint("bash", { command: "node -e 'process.exit(17)'" })
    const fp3 = normalizeGuardFingerprint("bash", { command: 'node   -e   "process.exit(17)"' })
    expect(fp1).toBe(fp2)
    expect(fp2).toBe(fp3)
  })

  it("enforces strategy invalidation on second identical blocked attempt and suppresses on third", () => {
    const sessionID = "ses_test_circuit"
    const toolName = "bash"
    const input = { command: 'node -e "console.log(1)"' }

    // Attempt 1: First block -> deny with executable alternatives
    const eval1 = orchestratorGuardStrategyCircuit.evaluateBlock({
      sessionID,
      toolName,
      input,
      reasonCode: "ORCHESTRATOR_GUARD_UNKNOWN_SHELL",
      reasonText: "`node` is not in the read-only allowlist",
    })
    expect(eval1.action).toBe("deny")
    expect(eval1.repeatCount).toBe(1)
    expect(eval1.incident.status).toBe("active")

    // Attempt 2: Unchanged blocked fingerprint -> deny_invalidated
    const eval2 = orchestratorGuardStrategyCircuit.evaluateBlock({
      sessionID,
      toolName,
      input,
      reasonCode: "ORCHESTRATOR_GUARD_UNKNOWN_SHELL",
      reasonText: "`node` is not in the read-only allowlist",
    })
    expect(eval2.action).toBe("deny_invalidated")
    expect(eval2.repeatCount).toBe(2)
    expect(eval2.incident.status).toBe("invalidated")

    // Attempt 3: Unchanged blocked attempt -> suppressed (circuit broken)
    const eval3 = orchestratorGuardStrategyCircuit.evaluateBlock({
      sessionID,
      toolName,
      input,
      reasonCode: "ORCHESTRATOR_GUARD_UNKNOWN_SHELL",
      reasonText: "`node` is not in the read-only allowlist",
    })
    expect(eval3.action).toBe("suppressed")
    expect(eval3.repeatCount).toBe(3)
    expect(eval3.incident.status).toBe("suppressed")
  })

  it("allows different legitimate operation without inheriting suppression", () => {
    const sessionID = "ses_test_diff_op"

    // Block operation A twice
    orchestratorGuardStrategyCircuit.evaluateBlock({
      sessionID,
      toolName: "bash",
      input: { command: "node -e 'bad()'" },
      reasonCode: "ORCHESTRATOR_GUARD_UNKNOWN_SHELL",
      reasonText: "blocked",
    })
    orchestratorGuardStrategyCircuit.evaluateBlock({
      sessionID,
      toolName: "bash",
      input: { command: "node -e 'bad()'" },
      reasonCode: "ORCHESTRATOR_GUARD_UNKNOWN_SHELL",
      reasonText: "blocked",
    })

    // Different operation B is evaluated cleanly
    const evalB = orchestratorGuardStrategyCircuit.evaluateBlock({
      sessionID,
      toolName: "bash",
      input: { command: "python -c 'different()'" },
      reasonCode: "ORCHESTRATOR_GUARD_UNKNOWN_SHELL",
      reasonText: "blocked",
    })
    expect(evalB.action).toBe("deny")
    expect(evalB.repeatCount).toBe(1)
  })

  it("resets blocked incidents when repository generation changes", () => {
    const sessionID = "ses_test_repo_gen"
    const input = { command: "node -e 'test()'" }

    orchestratorGuardStrategyCircuit.evaluateBlock({
      sessionID,
      toolName: "bash",
      input,
      reasonCode: "ORCHESTRATOR_GUARD_UNKNOWN_SHELL",
      reasonText: "blocked",
      repoGeneration: "gen_1",
    })

    // Record allowed progress with new repo generation
    orchestratorGuardStrategyCircuit.recordAllowedProgress(sessionID, "gen_2")

    // Attempting same input again starts fresh at repeatCount 1
    const evalFresh = orchestratorGuardStrategyCircuit.evaluateBlock({
      sessionID,
      toolName: "bash",
      input,
      reasonCode: "ORCHESTRATOR_GUARD_UNKNOWN_SHELL",
      reasonText: "blocked",
      repoGeneration: "gen_2",
    })
    expect(evalFresh.action).toBe("deny")
    expect(evalFresh.repeatCount).toBe(1)
  })
})
