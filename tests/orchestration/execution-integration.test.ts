import { describe, expect, it } from "bun:test"
import { pathOwnedBy } from "../../src/orchestration/execution/integration"

describe("controlled integration ownership matching", () => {
  it("matches directory glob claims without allowing sibling prefixes", () => {
    expect(pathOwnedBy("src/api/users.ts", "src/api/**")).toBe(true)
    expect(pathOwnedBy("src/api/users.ts", "src/api/*")).toBe(true)
    expect(pathOwnedBy("src/apis/users.ts", "src/api/**")).toBe(false)
    expect(pathOwnedBy("src/api.ts", "src/api/**")).toBe(false)
  })

  it("matches exact files and normalized separators", () => {
    expect(pathOwnedBy("src\\api\\users.ts", "src/api/users.ts")).toBe(true)
    expect(pathOwnedBy("src/api/users.ts", "src/api/users.ts")).toBe(true)
    expect(pathOwnedBy("src/api/users.test.ts", "src/api/users.ts")).toBe(false)
  })
})
