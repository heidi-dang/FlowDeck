import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  resolveGovernanceMode,
  evaluateGovernanceToolCheck,
} from "../src/services/governance-wiring"

describe("Governance Modes Matrix & Doctor Semantics Regression Suite", () => {
  it("resolves mode correctly for off, advisory, and strict configurations in .flowdeck.json", () => {
    const tmpOff = mkdtempSync(join(tmpdir(), "fdx-gov-off-"))
    const tmpAdv = mkdtempSync(join(tmpdir(), "fdx-gov-adv-"))
    const tmpStrict = mkdtempSync(join(tmpdir(), "fdx-gov-strict-"))

    try {
      writeFileSync(join(tmpOff, ".flowdeck.json"), JSON.stringify({ governance: { mode: "off" } }))
      writeFileSync(join(tmpAdv, ".flowdeck.json"), JSON.stringify({ governance: { mode: "advisory" } }))
      writeFileSync(join(tmpStrict, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))

      expect(resolveGovernanceMode(tmpOff)).toBe("off")
      expect(resolveGovernanceMode(tmpAdv)).toBe("advisory")
      expect(resolveGovernanceMode(tmpStrict)).toBe("strict")
    } finally {
      rmSync(tmpOff, { recursive: true, force: true })
      rmSync(tmpAdv, { recursive: true, force: true })
      rmSync(tmpStrict, { recursive: true, force: true })
    }
  })

  it("evaluates valid operations (heidi + bash) as ALLOW across all modes", () => {
    const tmpOff = mkdtempSync(join(tmpdir(), "fdx-gov-valid-"))
    const tmpAdv = mkdtempSync(join(tmpdir(), "fdx-gov-valid-"))
    const tmpStrict = mkdtempSync(join(tmpdir(), "fdx-gov-valid-"))

    try {
      writeFileSync(join(tmpOff, ".flowdeck.json"), JSON.stringify({ governance: { mode: "off" } }))
      writeFileSync(join(tmpAdv, ".flowdeck.json"), JSON.stringify({ governance: { mode: "advisory" } }))
      writeFileSync(join(tmpStrict, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))

      // Heidi + bash (valid operation)
      const resOff = evaluateGovernanceToolCheck({ directory: tmpOff, agent: "heidi", tool: "bash" })
      const resAdv = evaluateGovernanceToolCheck({ directory: tmpAdv, agent: "heidi", tool: "bash" })
      const resStrict = evaluateGovernanceToolCheck({ directory: tmpStrict, agent: "heidi", tool: "bash" })

      expect(resOff.action).toBe("allow")
      expect(resAdv.action).toBe("allow")
      expect(resStrict.action).toBe("allow")
    } finally {
      rmSync(tmpOff, { recursive: true, force: true })
      rmSync(tmpAdv, { recursive: true, force: true })
      rmSync(tmpStrict, { recursive: true, force: true })
    }
  })

  it("evaluates known contract violations (planner + bash) correctly per mode", () => {
    const tmpOff = mkdtempSync(join(tmpdir(), "fdx-gov-viol-"))
    const tmpAdv = mkdtempSync(join(tmpdir(), "fdx-gov-viol-"))
    const tmpStrict = mkdtempSync(join(tmpdir(), "fdx-gov-viol-"))

    try {
      writeFileSync(join(tmpOff, ".flowdeck.json"), JSON.stringify({ governance: { mode: "off" } }))
      writeFileSync(join(tmpAdv, ".flowdeck.json"), JSON.stringify({ governance: { mode: "advisory" } }))
      writeFileSync(join(tmpStrict, ".flowdeck.json"), JSON.stringify({ governance: { mode: "strict" } }))

      // Planner + bash (contract violation)
      const resOff = evaluateGovernanceToolCheck({ directory: tmpOff, agent: "planner", tool: "bash" })
      const resAdv = evaluateGovernanceToolCheck({ directory: tmpAdv, agent: "planner", tool: "bash" })
      const resStrict = evaluateGovernanceToolCheck({ directory: tmpStrict, agent: "planner", tool: "bash" })

      expect(resOff.action).toBe("allow")
      expect(resAdv.action).toBe("warn")
      expect(resStrict.action).toBe("block")
    } finally {
      rmSync(tmpOff, { recursive: true, force: true })
      rmSync(tmpAdv, { recursive: true, force: true })
      rmSync(tmpStrict, { recursive: true, force: true })
    }
  })
})
