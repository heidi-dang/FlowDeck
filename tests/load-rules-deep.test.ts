import { describe, it, expect } from "bun:test"
import {
  loadRulesTool,
  listRulesTool,
  resetLoadedRulesCache,
  getLoadedRulePaths
} from "../src/tools/load-rules"

describe("Load Rules Tool Deep Unit Tests", () => {
  it("loadRulesTool.execute loads rules for stage and language", async () => {
    resetLoadedRulesCache()
    expect(getLoadedRulePaths().length).toBe(0)

    const res = await (loadRulesTool.execute as any)({ stage: "execute", languages: ["typescript"] }, { directory: process.cwd() })
    const parsed = JSON.parse(res)
    expect(parsed).toBeDefined()
    expect(Array.isArray(parsed.loaded)).toBe(true)

    // Second call without force_reload skips already loaded
    const res2 = await (loadRulesTool.execute as any)({ stage: "execute", languages: ["typescript"] }, { directory: process.cwd() })
    const parsed2 = JSON.parse(res2)
    expect(parsed2.skipped_already_loaded.length).toBeGreaterThan(0)

    // Call with force_reload reloads rules
    const res3 = await (loadRulesTool.execute as any)({ stage: "execute", languages: ["typescript"], force_reload: true }, { directory: process.cwd() })
    const parsed3 = JSON.parse(res3)
    expect(parsed3.loaded.length).toBeGreaterThan(0)
  })

  it("listRulesTool.execute lists all available rules with metadata", async () => {
    const res = await (listRulesTool.execute as any)({}, { directory: process.cwd() })
    const parsed = JSON.parse(res)
    expect(parsed).toBeDefined()
    expect(typeof parsed.total).toBe("number")
    expect(Array.isArray(parsed.rules)).toBe(true)
  })
})
