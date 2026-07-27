/**
 * Package Export Contract Tests
 *
 * Verifies that the FlowDeck npm package exports are correct for all
 * supported module systems: ESM (import) and CJS (require).
 *
 * OpenCode v1.18.4 loads plugins via CJS require() on the `default`
 * or `require` export condition. The plugin must export { id, server }.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const PKG_PATH = join(__dirname, "..")
const PKG = JSON.parse(readFileSync(join(PKG_PATH, "package.json"), "utf-8"))

describe("Package export contract", () => {
  it("exports have all required conditions", () => {
    const ex = PKG.exports?.["."]
    expect(ex).toBeDefined()
    expect(ex).toHaveProperty("import")
    expect(ex).toHaveProperty("require")
    expect(ex).toHaveProperty("default")
  })

  it("ESM artifact exists and is valid", () => {
    const esmPath = join(PKG_PATH, PKG.exports?.["."]?.import ?? "")
    expect(existsSync(esmPath)).toBe(true)
  })

  it("CJS artifact exists and is valid", () => {
    const cjsPath = join(PKG_PATH, PKG.exports?.["."]?.require ?? "")
    expect(existsSync(cjsPath)).toBe(true)
  })

  it("server subpath export mirrors root export", () => {
    const server = PKG.exports?.["./server"]
    expect(server).toBeDefined()
    expect(server.import).toBe(PKG.exports?.["."]?.import)
    expect(server.require).toBe(PKG.exports?.["."]?.require)
  })
})

describe("ESM import contract", () => {
  it("default export is { id, server }", async () => {
    const mod = await import("@/index")
    expect(mod.default).toBeDefined()
    expect(mod.default).toHaveProperty("id")
    expect(mod.default).toHaveProperty("server")
    expect(mod.default.id).toBe("@heidi-dang/flowdeck")
    expect(typeof mod.default.server).toBe("function")
  })

  it("named exports are present", async () => {
    const mod = await import("@/index")
    expect(Array.isArray(mod.AGENT_NAMES)).toBe(true)
    expect(typeof mod.createAgent).toBe("function")
    expect(typeof mod.validateDelegationDepth).toBe("function")
    expect(typeof mod.evaluateGovernanceToolCheck).toBe("function")
  })

  it("AGENT_NAMES includes heidi and all canonical agents", async () => {
    const mod = await import("@/index")
    expect(mod.AGENT_NAMES).toContain("heidi")
    expect(mod.AGENT_NAMES).toContain("orchestrator")
    expect(mod.AGENT_NAMES).toContain("planner")
    expect(mod.AGENT_NAMES).toContain("backend-coder")
    expect(mod.AGENT_NAMES).toContain("frontend-coder")
    expect(mod.AGENT_NAMES).toContain("tester")
    expect(mod.AGENT_NAMES).toContain("reviewer")
    expect(mod.AGENT_NAMES).toContain("security-auditor")
    expect(mod.AGENT_NAMES.length).toBeGreaterThanOrEqual(10)
  })
})

describe("CJS require contract", () => {
  it("require returns { id, server } directly", () => {
    const mod = require(join(PKG_PATH, "dist", "index.cjs"))
    expect(mod).toBeDefined()
    expect(mod).toHaveProperty("id")
    expect(mod).toHaveProperty("server")
    expect(mod.id).toBe("@heidi-dang/flowdeck")
    expect(typeof mod.server).toBe("function")
    // CJS wrapper unwraps .default so mod === mod.default
    expect(mod.default).toBeDefined()
    expect(mod.default.id).toBe("@heidi-dang/flowdeck")
  })

  it("named exports are present via CJS wrapper", () => {
    const mod = require(join(PKG_PATH, "dist", "index.cjs"))
    expect(Array.isArray(mod.AGENT_NAMES)).toBe(true)
    expect(typeof mod.createAgent).toBe("function")
    expect(typeof mod.validateDelegationDepth).toBe("function")
  })
})
