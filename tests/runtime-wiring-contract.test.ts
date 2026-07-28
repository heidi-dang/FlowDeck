import { describe, expect, it } from "vitest"
import {
  CONFIG_RUNTIME_CONTRACT,
  HOOK_RUNTIME_CONTRACT,
  SERVICE_RUNTIME_CONTRACT,
} from "../src/runtime-wiring-contract"

describe("feature-to-runtime wiring contract", () => {
  it("accounts for every audited hook as wired or explicitly deprecated", () => {
    const expected = [
      "command-ref-guard",
      "context-window-monitor",
      "notifications",
      "patch-trust",
      "session-idle-hook",
      "shell-env-hook",
      "todo-hook",
    ]
    expect(Object.keys(HOOK_RUNTIME_CONTRACT).sort()).toEqual(expected)
    for (const entry of Object.values(HOOK_RUNTIME_CONTRACT)) {
      expect(["wired", "deprecated"]).toContain(entry.status)
      expect(entry.reason.length).toBeGreaterThan(10)
    }
  })

  it("accounts for every audited service as wired or explicitly deprecated", () => {
    const expected = [
      "candidate-approval",
      "config-editor",
      "heidi-execution-policy",
      "model-router",
      "preflight-explorer",
      "preflight-explorer-cache",
      "question-guard",
      "recovery-layer",
      "run-trace",
      "token-optimizer-service",
      "workflow",
    ]
    expect(Object.keys(SERVICE_RUNTIME_CONTRACT).sort()).toEqual(expected)
    for (const entry of Object.values(SERVICE_RUNTIME_CONTRACT)) {
      expect(["wired", "deprecated"]).toContain(entry.status)
      expect(entry.reason.length).toBeGreaterThan(10)
    }
  })

  it("accounts for every top-level FlowDeck config key", () => {
    expect(Object.keys(CONFIG_RUNTIME_CONTRACT).sort()).toEqual([
      "agentModels",
      "agents",
      "betterHarness",
      "designFirst",
      "governance",
      "maxDelegationDepth",
      "maxWritesPerAgent",
      "runtimeAgent",
      "supervisor",
    ])
    expect(CONFIG_RUNTIME_CONTRACT.supervisor.status).toBe("wired")
    expect(CONFIG_RUNTIME_CONTRACT.betterHarness.status).toBe("wired")
  })
})
