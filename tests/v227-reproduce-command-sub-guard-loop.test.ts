import { describe, it, expect, beforeEach } from "bun:test"
import { evaluateShellAuthorization } from "../src/services/shell-command-classifier"
import { orchestratorGuardStrategyCircuit } from "../src/services/orchestrator-guard-strategy-circuit"

describe("v2.2.6 Reproduction: Safe Command Substitution & Repeated Guard Retry", () => {
  beforeEach(() => {
    orchestratorGuardStrategyCircuit.clearAll()
  })

  it("verifies v2.2.7 allows safe command substitutions on $(date ...) and $(git rev-parse HEAD)", () => {
    const cmd1 = 'audit_id="heidi-v2.2.6-full-audit-$(date +%Y%m%d-%H%M%S)"'
    const auth1 = evaluateShellAuthorization(cmd1)
    expect(auth1.decision).toBe("ALLOW")
    expect(auth1.requiresHumanApproval).toBe(false)

    const cmd2 = 'sha=$(git rev-parse HEAD)'
    const auth2 = evaluateShellAuthorization(cmd2)
    expect(auth2.decision).toBe("ALLOW")
    expect(auth2.requiresHumanApproval).toBe(false)
  })
})
