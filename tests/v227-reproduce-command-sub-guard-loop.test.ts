import { describe, it, expect, beforeEach } from "bun:test"
import { classifyShellCommand } from "../src/services/shell-command-classifier"
import { orchestratorGuardStrategyCircuit } from "../src/services/orchestrator-guard-strategy-circuit"

describe("v2.2.6 Reproduction: Safe Command Substitution & Repeated Guard Retry", () => {
  beforeEach(() => {
    orchestratorGuardStrategyCircuit.clearAll()
  })

  it("reproduces v2.2.6 false-positive mutation block on $(date ...) and $(git rev-parse HEAD)", () => {
    const cmd1 = 'audit_id="heidi-v2.2.6-full-audit-$(date +%Y%m%d-%H%M%S)"'
    const cls1 = classifyShellCommand(cmd1)
    expect(cls1.category).toBe("read")

    const cmd2 = 'sha=$(git rev-parse HEAD)'
    const cls2 = classifyShellCommand(cmd2)
    expect(cls2.category).toBe("read")
  })
})
